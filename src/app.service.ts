// app.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ethers, Interface } from 'ethers';
import { spawn } from 'child_process';
import * as path from 'path';
import axios from 'axios';

type Hex = `0x${string}`;

// 영수증 데이터 인터페이스
interface ReceiptData {
  txHash: string;
  amount: string;
  token: string;
  from: string;
  to: string;
  timestamp: string;
  status: string;
  productName?: string; // 상품명 추가
  sessionId?: string;
}

// 인쇄 대기열 아이템 인터페이스
interface PrintQueueItem {
  id: string;
  receiptData: ReceiptData;
  createdAt: string;
  status: 'pending' | 'printing' | 'completed' | 'failed';
  attemptCount: number;
}

@Injectable()
export class AppService {
  private readonly logger = new Logger('AppService');
  
  // 인쇄 대기열 (메모리 기반 저장소)
  private printQueue: PrintQueueItem[] = [];
  
  // QR 스캔 세션 저장소 (실제 운영에서는 Redis 등 사용 권장)
  private sessionStorage = new Map<string, any>();

  private provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  private relayer = new ethers.Wallet(process.env.SPONSOR_PK!, this.provider);

  private readonly DELEGATE_ABI = [
    'function executeSignedTransfer((address from,address token,address to,uint256 amount,uint256 nonce,uint256 deadline) t, bytes sig) external',
    'function nonce() view returns (uint256)', // 뷰 호출용
  ];
  private readonly delegateIface = new Interface(this.DELEGATE_ABI);

  private readonly ERR_ABI = [
    'error BadContext(address actual,address expected)',
    'error Expired(uint256 nowTs,uint256 deadline)',
    'error BadSignature(address expected,address recovered)',
    'error BadNonce(uint256 got,uint256 expected)',
    'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
    'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
    'error SafeERC20FailedOperation(address token)',
  ];
  private readonly errIface = new Interface(this.ERR_ABI);

  private isAddr(a?: string) {
    return !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
  }
  private eqAddr(a?: string, b?: string) {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
  }
  private short(h?: string, n = 6) {
    if (!h || !h.startsWith('0x')) {
      return String(h);
    }
    
    // 거래 해시인 경우 (길이가 66인 경우) 전체 표시
    if (h.length === 66) {
      return h;
    }
    
    // 주소인 경우에만 축약
    return `${h.slice(0, 2 + n)}…${h.slice(-n)}`;
  }
  private j(obj: any) {
    return JSON.stringify(
      obj,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
  }

  private decodeAndLogRevert(e: any, tag: string) {
    const data = e?.info?.error?.data || e?.data;
    if (
      typeof data === 'string' &&
      data.startsWith('0x') &&
      data.length >= 10
    ) {
      try {
        const parsed = this.errIface.parseError(data);
        this.logger.error(
          `[${tag}] ${parsed?.name} args=${this.j(parsed?.args)}`,
        );
        return parsed;
      } catch {
        /* ignore */
      }
    }
    this.logger.error(`[${tag}] ${e?.shortMessage || e?.message || e}`);
    return null;
  }

  // ─────────────────────────────────────────
  // nextNonce 읽기: ① authorization 있으면 nonce() 뷰 호출 시도 → 실패 시 ② slot0
  // ─────────────────────────────────────────
  private async readNextNonce(
    authority: string,
    authorization?: {
      chainId: number;
      address: string;
      nonce: number;
      signature: Hex;
    },
  ): Promise<bigint> {
    // ① nonce() 뷰 시도 (type:4 + authorizationList 필요)
    if (authorization?.signature) {
      try {
        const data = this.delegateIface.encodeFunctionData('nonce', []);
        const ret = await this.provider.call({
          to: authority,
          data,
          type: 4,
          authorizationList: [authorization],
        } as any);
        const [val] = this.delegateIface.decodeFunctionResult('nonce', ret);
        const out = BigInt(val.toString());
        this.logger.debug(`[nextNonce:view] ${out.toString()}`);
        return out;
      } catch (e: any) {
        this.decodeAndLogRevert(e, 'nextNonce:view');
        // 폴백으로 진행
      }
    }

    // ② slot0 직접 조회 (EIP-7702 컨텍스트 없어도 항상 동작)
    const raw = await this.provider.getStorage(authority, 0);
    const out = BigInt(raw || 0);
    this.logger.debug(`[nextNonce:slot0] ${out.toString()}`);
    return out;
  }

  // (옵션) 클라이언트가 미리 nextNonce만 요청할 수 있게 제공
  async getNextNonce(
    authority: string,
    authorization?: {
      chainId: number;
      address: string;
      nonce: number;
      signature: Hex;
    },
  ) {
    if (!this.isAddr(authority))
      throw new BadRequestException('authority invalid');
    const next = await this.readNextNonce(authority, authorization);
    return {
      authority,
      nextNonce: next.toString(),
      via: authorization?.signature ? 'view-or-slot' : 'slot',
    };
  }

  // 메인 실행
  async payment(body: any) {
    const { authority, transfer, domain, types, signature712, authorization } =
      body ?? {};
    this.logger.debug(`[ADDRESS_DEBUG] authority=${authority}`);

    if (!this.isAddr(authority))
      throw new BadRequestException('authority invalid');
    if (!transfer) throw new BadRequestException('transfer missing');
    if (
      !this.isAddr(transfer.from) ||
      !this.isAddr(transfer.token) ||
      !this.isAddr(transfer.to)
    ) {
      throw new BadRequestException('transfer address invalid');
    }

    const net = await this.provider.getNetwork();
    if (Number(net.chainId) !== Number(domain?.chainId))
      throw new BadRequestException('chainId mismatch');
    if (!this.eqAddr(domain?.verifyingContract, authority))
      throw new BadRequestException('verifyingContract must equal authority');
    if (!this.eqAddr(transfer.from, authority))
      throw new BadRequestException('transfer.from must equal authority');

    const recovered = ethers.verifyTypedData(
      domain,
      types,
      {
        from: transfer.from,
        token: transfer.token,
        to: transfer.to,
        amount: BigInt(String(transfer.amount)),
        nonce: BigInt(String(transfer.nonce)),
        deadline: BigInt(String(transfer.deadline ?? 0)),
      },
      signature712,
    );
    if (!this.eqAddr(recovered, authority)) {
      throw new BadRequestException({
        code: 'BAD_712_SIGNER',
        recovered,
        authority,
      });
    }

    // ★ 여기서 nextNonce를 읽는다: authorization 있으면 nonce() 우선, 없으면 slot0
    const onchainNext = await this.readNextNonce(
      authority,
      authorization?.signature
        ? {
            chainId: Number(authorization.chainId),
            address: authorization.address,
            nonce: Number(authorization.nonce),
            signature: authorization.signature as Hex,
          }
        : undefined,
    );

    const tNonce = BigInt(String(transfer.nonce));
    if (onchainNext !== tNonce) {
      throw new BadRequestException({
        code: 'BAD_NONCE',
        message: 'transfer.nonce does not match onchain nextNonce',
        got: tNonce.toString(),
        expected: onchainNext.toString(),
      });
    }

    // 잔고 체크
    const erc20 = new ethers.Contract(
      transfer.token,
      [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ],
      this.provider,
    );
    let bal: bigint;
    try {
      const b = await erc20.balanceOf(authority);
      bal = BigInt(b.toString());
    } catch {
      bal = 0n;
    }
    const needed = BigInt(String(transfer.amount));
    if (bal < needed) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        balance: bal.toString(),
        needed: needed.toString(),
      });
    }

    // calldata
    const calldata = this.delegateIface.encodeFunctionData(
      'executeSignedTransfer',
      [
        {
          from: transfer.from,
          token: transfer.token,
          to: transfer.to,
          amount: needed,
          nonce: tNonce,
          deadline: BigInt(String(transfer.deadline ?? 0)),
        },
        signature712,
      ],
    );
    this.logger.debug(
      `[calldata] len=${(calldata.length - 2) / 2}B hash=${ethers.keccak256(calldata)}`,
    );

    // authorizationList
    const authList: Array<{
      chainId: number;
      address: string;
      nonce: number;
      signature: Hex;
    }> = [];
    if (authorization?.signature) {
      if (!this.isAddr(authorization.address))
        throw new BadRequestException('authorization.address invalid');
      authList.push({
        chainId: Number(authorization.chainId),
        address: authorization.address,
        nonce: Number(authorization.nonce),
        signature: authorization.signature as Hex,
      });
    }

    // simulate
    try {
      await this.provider.call({
        to: authority,
        data: calldata,
        type: 4,
        authorizationList: authList,
      } as any);
      this.logger.log('[simulate] OK');
    } catch (e: any) {
      const parsed = this.decodeAndLogRevert(e, 'simulate');
      if (parsed?.name === 'BadNonce' && parsed?.args?.length >= 2) {
        const got = BigInt(String(parsed.args[0]));
        const expected = BigInt(String(parsed.args[1]));
        throw new BadRequestException({
          code: 'BAD_NONCE',
          got: got.toString(),
          expected: expected.toString(),
        });
      }
      throw e;
    }

    // send
    const tx = await this.relayer.sendTransaction({
      to: authority,
      data: calldata,
      type: 4,
      authorizationList: authList as any,
    });

    try {
      const rc = await tx.wait();
      this.logger.log(
        `[mined] status=${rc?.status} gasUsed=${rc?.gasUsed?.toString()}`,
      );
    } catch (e: any) {
      this.logger.warn(`[wait] ${e?.message || e}`);
    }

    const result = { status: 'ok', txHash: tx.hash };

    // 영수증 인쇄는 호출자에서 처리하도록 변경
    // (gaslessPayment, scanPayment 등에서 각각 처리)

    return result;
  }

  // 가스리스 결제 처리 (client.ts 실행)
  async gaslessPayment(body: any) {
    const { qrData } = body ?? {};

    if (!qrData) {
      throw new BadRequestException('QR 데이터가 없습니다.');
    }

    // 필수 필드 검증
    const requiredFields = [
      'token',
      'to',
      'amountWei',
      'chainId',
      'delegateAddress',
      'rpcUrl',
      'timestamp',
    ];
    for (const field of requiredFields) {
      if (!qrData[field]) {
        throw new BadRequestException(`${field} 필드가 없습니다.`);
      }
    }

    // 타임스탬프 검증 제거 - QR 코드는 상시 사용 가능해야 함

    this.logger.log(`[GASLESS_PAYMENT] QR 스캔 결제 요청 시작`);

    // 환경변수 임시 설정
    const originalEnv = {
      TOKEN: process.env.TOKEN,
      TO: process.env.TO,
      AMOUNT_WEI: process.env.AMOUNT_WEI,
      CHAIN_ID: process.env.CHAIN_ID,
      DELEGATE_ADDRESS: process.env.DELEGATE_ADDRESS,
      RPC_URL: process.env.RPC_URL,
    };

    try {
      // QR 데이터로 환경변수 임시 변경
      process.env.TOKEN = qrData.token;
      process.env.TO = qrData.to;
      process.env.AMOUNT_WEI = qrData.amountWei;
      process.env.CHAIN_ID = qrData.chainId.toString();
      process.env.DELEGATE_ADDRESS = qrData.delegateAddress;
      process.env.RPC_URL = qrData.rpcUrl;

      // client.ts 실행
      const clientPath = path.resolve(process.cwd(), 'client.ts');

      return await new Promise((resolve, reject) => {
        // Windows 호환성을 위해 shell: true 옵션과 ts-node 사용
        const clientProcess = spawn('npx', ['ts-node', clientPath], {
          stdio: ['inherit', 'pipe', 'pipe'],
          shell: true, // Windows에서 npx.cmd를 찾을 수 있도록
        });

        let stdout = '';
        let stderr = '';

        clientProcess.stdout.on('data', (data) => {
          const output = data.toString();
          stdout += output;
          this.logger.debug(`[CLIENT_OUTPUT] ${output.trim()}`);
        });

        clientProcess.stderr.on('data', (data) => {
          const error = data.toString();
          stderr += error;
          this.logger.error(`[CLIENT_ERROR] ${error.trim()}`);
        });

        clientProcess.on('close', (code) => {
          if (code === 0) {
            this.logger.log(`[GASLESS_PAYMENT] client.ts 실행 완료`);

            // stdout에서 결과 파싱 시도
            try {
              // 먼저 txHash를 추출하여 중복 인쇄 방지
              let extractedTxHash: string | null = null;
              
              // 1. server: 줄에서 txHash 추출 시도
              const lines = stdout.split('\n');
              let parsedResult: any = null;
              
              for (const line of lines) {
                if (line.includes('server:')) {
                  this.logger.log(`[PARSE_DEBUG] Found server line: ${line}`);
                  const jsonMatch = line.match(/server:\s*({.*})/);
                  if (jsonMatch) {
                    try {
                      parsedResult = JSON.parse(jsonMatch[1]);
                      this.logger.log(`[PARSE_SUCCESS] Parsed result: ${JSON.stringify(parsedResult)}`);
                      if (parsedResult && parsedResult.txHash) {
                        extractedTxHash = parsedResult.txHash;
                        break; // txHash를 찾았으므로 루프 종료
                      }
                    } catch (parseError: any) {
                      this.logger.warn(`[PARSE_ERROR] JSON parse failed: ${parseError.message}`);
                      this.logger.warn(`[PARSE_ERROR] Raw JSON: ${jsonMatch[1]}`);
                    }
                  }
                }
              }

              // 2. server 줄에서 txHash를 찾지 못한 경우, logs에서 직접 추출
              if (!extractedTxHash) {
                const txHashMatch = stdout.match(/txHash['":\s]*['"]?(0x[0-9a-fA-F]{64})['"]?/);
                if (txHashMatch && txHashMatch[1]) {
                  extractedTxHash = txHashMatch[1];
                  this.logger.log(`[EXTRACT_TXHASH] Extracted txHash from logs: ${extractedTxHash}`);
                }
              }

              // 3. txHash가 있으면 한 번만 영수증 인쇄
              if (extractedTxHash) {
                this.logger.log(`[SINGLE_RECEIPT_PRINT] 영수증 한 번만 인쇄 - txHash: ${extractedTxHash}`);
                this.printReceipt({
                  txHash: extractedTxHash,
                  amount: qrData.amountWei,
                  token: qrData.token,
                  from: 'GASLESS_USER', // 가스리스 결제의 경우
                  to: qrData.to,
                  timestamp: new Date().toISOString(),
                  status: 'success',
                  productName: '아메리카노', // 상품명 추가
                }).catch(printError => {
                  this.logger.warn(`[RECEIPT_PRINT_ERROR] ${printError.message}`);
                  // 영수증 인쇄 실패해도 결제 성공은 유지
                });
              }

              // 4. 응답 반환
              if (parsedResult && extractedTxHash) {
                resolve(parsedResult);
              } else {
                const response = {
                  status: 'ok',
                  message: '가스리스 결제가 성공적으로 처리되었습니다.',
                  logs: stdout,
                };
                
                if (extractedTxHash) {
                  response['txHash'] = extractedTxHash;
                }
                
                resolve(response);
              }
            } catch (e) {
              this.logger.error(`[PARSE_EXCEPTION] ${e.message}`);
              resolve({
                status: 'ok',
                message: '가스리스 결제가 처리되었습니다.',
                logs: stdout,
              });
            }
          } else {
            this.logger.error(
              `[GASLESS_PAYMENT] client.ts 실행 실패, exit code: ${code}`,
            );
            reject(
              new BadRequestException(
                `결제 처리 실패: ${stderr || '알 수 없는 오류'}`,
              ),
            );
          }
        });

        clientProcess.on('error', (error) => {
          this.logger.error(
            `[GASLESS_PAYMENT] client.ts 실행 에러: ${error.message}`,
          );
          reject(new BadRequestException(`결제 처리 에러: ${error.message}`));
        });
      });
    } finally {
      // 환경변수 복원
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      }
    }
  }

  // QR 스캔 결제 - 개인키 세션 저장
  async storePrivateKeySession(body: any) {
    const { type, sessionId, encryptedPrivateKey, expiresAt } = body;

    if (type !== 'private_key_session') {
      throw new BadRequestException('잘못된 QR 코드 타입입니다.');
    }

    if (!sessionId || !encryptedPrivateKey) {
      throw new BadRequestException('필수 데이터가 누락되었습니다.');
    }

    // 만료 시간 확인
    if (new Date(expiresAt) <= new Date()) {
      throw new BadRequestException('만료된 QR 코드입니다.');
    }

    // 세션 저장
    this.sessionStorage.set(sessionId, {
      encryptedPrivateKey,
      expiresAt,
      storedAt: new Date().toISOString(),
    });

    this.logger.log(`[SESSION_STORED] sessionId: ${sessionId}`);

    return {
      status: 'success',
      message: '개인키 세션이 저장되었습니다.',
      sessionId,
    };
  }

  // QR 스캔 결제 - 결제 실행
  async scanPayment(body: any) {
    const { type, sessionId, recipient, amount, token } = body;

    if (type !== 'payment_request') {
      throw new BadRequestException('잘못된 QR 코드 타입입니다.');
    }

    if (!sessionId || !recipient || !amount || !token) {
      throw new BadRequestException('필수 결제 정보가 누락되었습니다.');
    }

    // 세션 확인
    const session = this.sessionStorage.get(sessionId);
    if (!session) {
      throw new BadRequestException('세션을 찾을 수 없습니다. 개인키 QR을 다시 스캔해주세요.');
    }

    // 세션 만료 확인
    if (new Date(session.expiresAt) <= new Date()) {
      this.sessionStorage.delete(sessionId);
      throw new BadRequestException('세션이 만료되었습니다. 개인키 QR을 다시 스캔해주세요.');
    }

    try {
      this.logger.log(`[SCAN_PAYMENT] 결제 시작 - sessionId: ${sessionId}, amount: ${amount}`);

      // 여기서 실제 결제 로직 실행
      // 기존 payment 메서드와 유사한 로직을 사용하되, 개인키는 세션에서 가져옴
      
      // 임시로 성공 응답 (실제로는 블록체인 거래 처리)
      const txHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
      
      const paymentResult = {
        status: 'success',
        txHash,
        amount,
        token,
        recipient,
        sessionId,
        timestamp: new Date().toISOString(),
      };

      // 결제 성공 후 영수증 인쇄 호출
      try {
        await this.printReceipt({
          txHash: paymentResult.txHash,
          amount: paymentResult.amount,
          token: paymentResult.token,
          from: 'QR_SCAN_USER', // QR 스캔 결제의 경우
          to: paymentResult.recipient,
          timestamp: paymentResult.timestamp,
          status: 'success',
          productName: '아메리카노', // 상품명 추가
          sessionId: paymentResult.sessionId,
        });
      } catch (printError: any) {
        this.logger.warn(`[RECEIPT_PRINT_ERROR] ${printError.message}`);
        // 영수증 인쇄 실패해도 결제 성공은 유지
      }

      // 세션 정리
      this.sessionStorage.delete(sessionId);

      this.logger.log(`[SCAN_PAYMENT] 결제 완료 - txHash: ${txHash}`);

      return {
        paymentResult,
        status: 'success',
        message: '2단계 QR 스캔 결제가 완료되었습니다.',
      };

    } catch (error: any) {
      this.logger.error(`[SCAN_PAYMENT_ERROR] ${error.message}`);
      throw new BadRequestException(`결제 처리 실패: ${error.message}`);
    }
  }

  // 영수증 인쇄 요청 (대기열에 저장)
  async printReceipt(receiptData: ReceiptData) {
    try {
      this.logger.log(`[RECEIPT_PRINT] 영수증 인쇄 요청 시작 - txHash: ${receiptData.txHash}`);

      // 인쇄 대기열 아이템 생성
      const printItem: PrintQueueItem = {
        id: `print_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        receiptData,
        createdAt: new Date().toISOString(),
        status: 'pending',
        attemptCount: 0,
      };

      // 대기열에 추가
      this.printQueue.push(printItem);
      
      this.logger.log(`[RECEIPT_QUEUE] 인쇄 대기열에 추가됨 - ID: ${printItem.id}, txHash: ${receiptData.txHash}`);
      this.logger.log(`[RECEIPT_QUEUE] 현재 대기열 크기: ${this.printQueue.length}`);

      return {
        status: 'success',
        message: '영수증이 인쇄 대기열에 추가되었습니다.',
        printJobId: printItem.id,
        queueSize: this.printQueue.length,
      };

    } catch (error: any) {
      this.logger.error(`[RECEIPT_PRINT_ERROR] ${error.message}`);
      throw new BadRequestException(`영수증 인쇄 대기열 추가 실패: ${error.message}`);
    }
  }

  // 인쇄 대기열 조회 (Android APP에서 폴링)
  async getPrintQueue() {
    try {
      // pending 상태인 아이템들만 반환
      const pendingItems = this.printQueue.filter(item => item.status === 'pending');
      
      this.logger.log(`[PRINT_QUEUE] 대기열 조회 - 전체: ${this.printQueue.length}개, 대기중: ${pendingItems.length}개`);
      
      return {
        status: 'success',
        totalItems: this.printQueue.length,
        pendingItems: pendingItems.length,
        items: pendingItems.map(item => ({
          id: item.id,
          transactionHash: item.receiptData.txHash,
          amount: item.receiptData.amount,
          token: item.receiptData.token,
          fromAddress: item.receiptData.from,
          toAddress: item.receiptData.to,
          timestamp: item.receiptData.timestamp,
          productName: item.receiptData.productName || '아메리카노', // 상품명 추가
          createdAt: item.createdAt,
          attemptCount: item.attemptCount,
        })),
      };

    } catch (error: any) {
      this.logger.error(`[PRINT_QUEUE_ERROR] ${error.message}`);
      throw new BadRequestException(`인쇄 대기열 조회 실패: ${error.message}`);
    }
  }

  // 인쇄 작업 상태 업데이트
  async updatePrintStatus(printId: string, status: 'printing' | 'completed' | 'failed', errorMessage?: string) {
    try {
      const itemIndex = this.printQueue.findIndex(item => item.id === printId);
      
      if (itemIndex === -1) {
        throw new Error(`인쇄 작업을 찾을 수 없습니다: ${printId}`);
      }

      const item = this.printQueue[itemIndex];
      item.status = status;
      item.attemptCount += 1;

      this.logger.log(`[PRINT_STATUS] 인쇄 상태 업데이트 - ID: ${printId}, 상태: ${status}, 시도횟수: ${item.attemptCount}`);

      if (status === 'completed') {
        // 완료된 항목은 30초 후 대기열에서 제거
        setTimeout(() => {
          const index = this.printQueue.findIndex(item => item.id === printId);
          if (index !== -1) {
            this.printQueue.splice(index, 1);
            this.logger.log(`[PRINT_CLEANUP] 완료된 인쇄 작업 정리 - ID: ${printId}`);
          }
        }, 30000);
      } else if (status === 'failed') {
        // 실패한 경우 3번 시도 후 대기열에서 제거
        if (item.attemptCount >= 3) {
          this.printQueue.splice(itemIndex, 1);
          this.logger.warn(`[PRINT_FAILED] 인쇄 작업 최종 실패 후 제거 - ID: ${printId}`);
        } else {
          // 재시도를 위해 pending 상태로 복구
          item.status = 'pending';
          this.logger.log(`[PRINT_RETRY] 인쇄 작업 재시도 예정 - ID: ${printId}, 시도횟수: ${item.attemptCount}`);
        }
      }

      return {
        status: 'success',
        message: `인쇄 상태가 업데이트되었습니다: ${status}`,
        printId,
        newStatus: item.status,
        attemptCount: item.attemptCount,
      };

    } catch (error: any) {
      this.logger.error(`[PRINT_STATUS_ERROR] ${error.message}`);
      throw new BadRequestException(`인쇄 상태 업데이트 실패: ${error.message}`);
    }
  }

  // 인쇄 대기열 통계
  async getPrintQueueStats() {
    const stats = {
      total: this.printQueue.length,
      pending: this.printQueue.filter(item => item.status === 'pending').length,
      printing: this.printQueue.filter(item => item.status === 'printing').length,
      completed: this.printQueue.filter(item => item.status === 'completed').length,
      failed: this.printQueue.filter(item => item.status === 'failed').length,
    };

    this.logger.log(`[PRINT_STATS] 대기열 통계: ${JSON.stringify(stats)}`);
    
    return {
      status: 'success',
      stats,
      lastUpdate: new Date().toISOString(),
    };
  }
}

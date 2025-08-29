// app.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ethers, Interface } from 'ethers';
import { spawn } from 'child_process';
import * as path from 'path';

type Hex = `0x${string}`;

@Injectable()
export class AppService {
  private readonly logger = new Logger('AppService');

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
    return !h || !h.startsWith('0x')
      ? String(h)
      : `${h.slice(0, 2 + n)}…${h.slice(-n)}`;
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

    return { status: 'ok', txHash: tx.hash };
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
              const lines = stdout.split('\n');
              let parsedResult: any = null;
              
              // 먼저 "server:"가 포함된 줄을 찾기
              for (const line of lines) {
                if (line.includes('server:')) {
                  this.logger.log(`[PARSE_DEBUG] Found server line: ${line}`);
                  const jsonMatch = line.match(/server:\s*({.*})/);
                  if (jsonMatch) {
                    try {
                      parsedResult = JSON.parse(jsonMatch[1]);
                      this.logger.log(`[PARSE_SUCCESS] Parsed result: ${JSON.stringify(parsedResult)}`);
                      if (parsedResult && parsedResult.txHash) {
                        return resolve(parsedResult);
                      }
                    } catch (parseError: any) {
                      this.logger.warn(`[PARSE_ERROR] JSON parse failed: ${parseError.message}`);
                      this.logger.warn(`[PARSE_ERROR] Raw JSON: ${jsonMatch[1]}`);
                    }
                  }
                }
              }

              // server: 줄을 찾았지만 txHash가 없는 경우, logs에서 txHash 추출 시도
              if (parsedResult && !parsedResult.txHash) {
                const txHashMatch = stdout.match(/txHash['":\s]*['"]?(0x[0-9a-fA-F]{64})['"]?/);
                if (txHashMatch && txHashMatch[1]) {
                  parsedResult.txHash = txHashMatch[1];
                  this.logger.log(`[EXTRACT_TXHASH] Extracted txHash from logs: ${parsedResult.txHash}`);
                  return resolve(parsedResult);
                }
              }

              // 기본 성공 응답 (logs 포함하여 프론트엔드에서 추가 파싱 가능)
              const response = {
                status: 'ok',
                message: '가스리스 결제가 성공적으로 처리되었습니다.',
                logs: stdout,
              };
              
              // logs에서 txHash 추출 시도
              const txHashMatch = stdout.match(/txHash['":\s]*['"]?(0x[0-9a-fA-F]{64})['"]?/);
              if (txHashMatch && txHashMatch[1]) {
                response['txHash'] = txHashMatch[1];
                this.logger.log(`[FALLBACK_TXHASH] Extracted txHash: ${response['txHash']}`);
              }
              
              resolve(response);
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
}

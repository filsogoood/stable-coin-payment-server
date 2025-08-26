// app.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  decodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  verifyTypedData,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type TypedData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

@Injectable()
export class AppService {
  private readonly logger = new Logger('AppService');

  private publicClient = createPublicClient({
    transport: http(process.env.RPC_URL, {
      timeout: 30_000, // 30초 타임아웃
      retryCount: 3,   // 3번 재시도
      retryDelay: 1000, // 1초 대기
    }),
  });

  private relayerAccount = privateKeyToAccount(process.env.SPONSOR_PK! as Hex);
  private relayerClient = createWalletClient({
    account: this.relayerAccount,
    transport: http(process.env.RPC_URL, {
      timeout: 30_000, // 30초 타임아웃  
      retryCount: 3,   // 3번 재시도
      retryDelay: 1000, // 1초 대기
    }),
  });

  private readonly DELEGATE_ABI = [
    {
      name: 'executeSignedTransfer',
      type: 'function',
      inputs: [
        {
          name: 't',
          type: 'tuple',
          components: [
            { name: 'from', type: 'address' },
            { name: 'token', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        { name: 'sig', type: 'bytes' },
      ],
      outputs: [],
    },
    {
      name: 'nonce',
      type: 'function',
      inputs: [],
      outputs: [{ type: 'uint256' }],
    },
  ] as const;

  private readonly ERROR_ABI = [
    'error BadContext(address actual,address expected)',
    'error Expired(uint256 nowTs,uint256 deadline)',
    'error BadSignature(address expected,address recovered)',
    'error BadNonce(uint256 got,uint256 expected)',
    'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
    'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
    'error SafeERC20FailedOperation(address token)',
  ];

  private isAddr(a?: string): a is Address {
    return !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
  }

  private eqAddr(a?: string, b?: string) {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
  }

  private short(h?: string, n = 6) {
    return (!h || !h.startsWith('0x')) ? String(h) : (`${h.slice(0, 2 + n)}…${h.slice(-n)}`);
  }

  private j(obj: any) {
    return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  }

  private decodeAndLogRevert(e: any, tag: string) {
    const data = e?.details || e?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        // viem에서는 에러 디코딩을 직접 처리해야 함
        this.logger.error(`[${tag}] Revert data: ${data}`);
        return { data };
      } catch {
        /* ignore */
      }
    }
    this.logger.error(`[${tag}] ${e?.shortMessage || e?.message || e}`);
    return null;
  }

  // nextNonce 읽기: authorization 있으면 nonce() 뷰 호출 시도 → 실패 시 slot0
  private async readNextNonce(
    authority: Address,
    authorization?: {
      chainId: number;
      address: Address;
      nonce: number;
      signature: Hex;
    }
  ): Promise<bigint> {
    // ① nonce() 뷰 시도 (type:4 + authorizationList 필요)
    if (authorization?.signature) {
      try {
        const data = encodeFunctionData({
          abi: this.DELEGATE_ABI,
          functionName: 'nonce',
          args: [],
        });

        const ret = await this.publicClient.call({
          to: authority,
          data,
          type: 'eip7702',
          authorizationList: [{
            chainId: `0x${authorization!.chainId.toString(16)}`,
            address: authorization!.address,
            nonce: `0x${authorization!.nonce.toString(16)}`,
            signature: authorization!.signature,
          }],
        } as any);

        const result = decodeFunctionResult({
          abi: this.DELEGATE_ABI,
          functionName: 'nonce',
          data: ret.data!,
        });

        const out = result as bigint;
        this.logger.debug(`[nextNonce:view] ${out.toString()}`);
        return out;
      } catch (e: any) {
        this.decodeAndLogRevert(e, 'nextNonce:view');
        // 폴백으로 진행
      }
    }

    // ② slot0 직접 조회
    const raw = await this.publicClient.getStorageAt({
      address: authority,
      slot: '0x0',
    });
    const out = BigInt(raw || 0);
    this.logger.debug(`[nextNonce:slot0] ${out.toString()}`);
    return out;
  }

  // nextNonce만 요청
  async getNextNonce(
    authority: string,
    authorization?: { chainId: number; address: string; nonce: number; signature: Hex }
  ) {
    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    const next = await this.readNextNonce(authority, authorization ? {
      chainId: authorization.chainId,
      address: authorization.address as Address,
      nonce: authorization.nonce,
      signature: authorization.signature,
    } : undefined);
    return { authority, nextNonce: next.toString(), via: authorization?.signature ? 'view-or-slot' : 'slot' };
  }

  // 서버에서 Authorization을 생성하는 메소드 수정 (EIP-7702 표준 준수)
  private async generateServerAuthorization(authorityAddress: Address): Promise<{
    chainId: number;
    address: Address;
    nonce: number;
    r: Hex;
    s: Hex;
    yParity: number;
  }> {
    try {
      this.logger.log(`🔐 서버에서 EIP-7702 Authorization 생성 중... authority: ${authorityAddress}`);
      
      // 환경 변수 확인
      if (!process.env.SPONSOR_PK) {
        throw new Error('SPONSOR_PK 환경 변수가 설정되지 않았습니다.');
      }
      if (!process.env.DELEGATE_ADDRESS) {
        throw new Error('DELEGATE_ADDRESS 환경 변수가 설정되지 않았습니다.');
      }
      
      // Authority의 현재 nonce 가져오기
      this.logger.debug('📊 Authority EOA nonce 조회 중...');
      const eoaNonceLatest = await this.publicClient.getTransactionCount({
        address: authorityAddress,
        blockTag: 'latest'
      });

      this.logger.debug(`📊 Authority EOA nonce: ${eoaNonceLatest}`);

      const chainId = await this.publicClient.getChainId();
      this.logger.debug(`🌐 Chain ID: ${chainId}`);

      // EIP-7702 Authorization 구조체
      const authorization = {
        chainId: Number(chainId),
        address: process.env.DELEGATE_ADDRESS! as Address,
        nonce: Number(eoaNonceLatest),
      };

      this.logger.debug('📋 Authorization 구조체:', authorization);

      // EIP-7702 Authorization의 TypedData 구조
      const domain = {
        name: 'Eip7702Authorization',
        version: '1',
        chainId: Number(chainId),
      };

      const types = {
        Authorization: [
          { name: 'chainId', type: 'uint256' },
          { name: 'address', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      };

      this.logger.debug('✍️ Authorization TypedData 서명 중...');

      // 실제 환경에서는 사용자가 서명해야 하지만, 
      // 가스리스 데모를 위해 서버의 relayer account로 서명
      // ⚠️ 주의: 실제 프로덕션에서는 보안상 문제가 될 수 있음
      const authorizationSignature = await this.relayerClient.signTypedData({
        account: this.relayerAccount,
        domain,
        types,
        primaryType: 'Authorization',
        message: authorization,
      });

      // EIP-7702에서 요구하는 r, s, yParity 형식으로 분리
      const signature = authorizationSignature.slice(2); // 0x 제거
      const r = `0x${signature.slice(0, 64)}` as Hex;
      const s = `0x${signature.slice(64, 128)}` as Hex;
      const v = parseInt(signature.slice(128, 130), 16);
      const yParity = v >= 27 ? v - 27 : v; // v를 yParity로 변환

      this.logger.debug('🔑 서명 분리 완료:', { r, s, yParity });

      this.logger.log(`✅ EIP-7702 Authorization 생성 완료`);
      this.logger.warn(`⚠️ 데모 목적: 실제 환경에서는 사용자가 직접 authorization을 서명해야 합니다.`);

      return {
        chainId: authorization.chainId,
        address: authorization.address,
        nonce: authorization.nonce,
        r,
        s,
        yParity,
      };
    } catch (error) {
      this.logger.error(`❌ EIP-7702 Authorization 생성 실패:`, error);
      this.logger.error(`❌ Error details:`, {
        message: error.message,
        stack: error.stack,
        authorityAddress,
        envVars: {
          SPONSOR_PK: !!process.env.SPONSOR_PK,
          DELEGATE_ADDRESS: !!process.env.DELEGATE_ADDRESS,
          RPC_URL: !!process.env.RPC_URL,
        }
      });
      throw new BadRequestException(`EIP-7702 Authorization 생성에 실패했습니다: ${error.message}`);
    }
  }

  // 새로운 서버 기반 결제 처리 엔드포인트
  async processServerPayment(body: any) {
    try {
      const { authority, transfer, domain, types, signature712 } = body ?? {};
      this.logger.debug(`[SERVER_PAYMENT] authority=${authority}`);

      if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
      if (!transfer) throw new BadRequestException('transfer missing');
      if (
        !this.isAddr(transfer.from) ||
        !this.isAddr(transfer.token) ||
        !this.isAddr(transfer.to)
      ) {
        throw new BadRequestException('transfer address invalid');
      }

      const chainId = await this.publicClient.getChainId();
      if (Number(chainId) !== Number(domain?.chainId)) {
        throw new BadRequestException('chainId mismatch');
      }
      if (!this.eqAddr(domain?.verifyingContract, process.env.DELEGATE_ADDRESS)) {
        throw new BadRequestException('verifyingContract must equal DELEGATE_ADDRESS (EIP-7702 contract)');
      }
      if (!this.eqAddr(transfer.from, authority)) {
        throw new BadRequestException('transfer.from must equal authority');
      }

      // 서버에서 Authorization 생성
      this.logger.log('🔐 서버에서 Authorization 생성 시작...');
      const serverAuthorization = await this.generateServerAuthorization(authority as Address);
      this.logger.log('✅ 서버 Authorization 생성 완료');

      // EIP-712 서명 검증
      const transferData = {
        from: transfer.from as Address,
        token: transfer.token as Address,
        to: transfer.to as Address,
        amount: BigInt(String(transfer.amount)),
        nonce: BigInt(String(transfer.nonce)),
        deadline: BigInt(String(transfer.deadline ?? 0)),
      };

      const valid = await verifyTypedData({
        address: authority as Address,
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: domain.verifyingContract as Address,
        },
        types: types as any,
        primaryType: 'Transfer',
        message: transferData as any,
        signature: signature712 as Hex,
      });

      if (!valid) {
        throw new BadRequestException({ code: 'BAD_712_SIGNATURE', authority });
      }

      // nextNonce 읽기 (서버에서 생성한 authorization 사용) - 임시로 간단한 방법 사용
      const onchainNext = await this.readNextNonce(authority as Address);

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
      let bal: bigint;
      try {
        bal = await this.publicClient.readContract({
          address: transfer.token as Address,
          abi: [
            {
              name: 'balanceOf',
              type: 'function',
              inputs: [{ type: 'address' }],
              outputs: [{ type: 'uint256' }],
            },
          ],
          functionName: 'balanceOf',
          args: [authority as Address],
        }) as bigint;
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
      const calldata = encodeFunctionData({
        abi: this.DELEGATE_ABI,
        functionName: 'executeSignedTransfer',
        args: [
          {
            from: transfer.from as Address,
            token: transfer.token as Address,
            to: transfer.to as Address,
            amount: needed,
            nonce: tNonce,
            deadline: BigInt(String(transfer.deadline ?? 0)),
          },
          signature712 as Hex,
        ],
      });

      this.logger.debug(`[calldata] len=${(calldata.length - 2) / 2}B hash=${this.short(keccak256(calldata))}`);

      // 서버에서 생성한 authorizationList 사용 (EIP-7702 형식)
      const authList = [{
        chainId: `0x${serverAuthorization.chainId.toString(16)}` as any,
        address: serverAuthorization.address,
        nonce: `0x${serverAuthorization.nonce.toString(16)}` as any,
        r: serverAuthorization.r,
        s: serverAuthorization.s,
        yParity: `0x${serverAuthorization.yParity.toString(16)}` as any,
      }];

      this.logger.debug(`[서버 Authorization] EIP-7702 사용: ${this.short(serverAuthorization.address)}`);

      // simulate - EIP-7702 지원
      try {
        const callParams: any = {
          to: authority as Address,
          data: calldata,
          type: 'eip7702',
          authorizationList: authList,
        };
        
        await this.publicClient.call(callParams);
        this.logger.log('[simulate] OK');
      } catch (e: any) {
        const parsed = this.decodeAndLogRevert(e, 'simulate');
        throw e;
      }

      // 가스리스 트랜잭션 전송 (SPONSOR_PK로 가스비 지불)
      const txParams: any = {
        to: authority as Address,
        data: calldata,
        authorizationList: authList,
        chain: null,
      };
      
      const txHash = await this.relayerClient.sendTransaction(txParams);

      this.logger.log(`[가스리스 트랜잭션 전송 완료] txHash=${txHash}`);

      return { 
        status: 'ok', 
        txHash,
        message: '가스리스 결제가 완료되었습니다.',
        authorization: serverAuthorization
      };

    } catch (error) {
      this.logger.error(`❌ processServerPayment 오류:`, error);
      this.logger.error(`❌ Error stack:`, error.stack);
      
      // 구체적인 에러 메시지 반환
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      throw new BadRequestException(`서버 처리 중 오류 발생: ${error.message}`);
    }
  }

  // 메인 실행
  async payment(body: any) {
    const { authority, transfer, domain, types, signature712, authorization } = body ?? {};
    this.logger.debug(`[ADDRESS_DEBUG] authority=${authority}`);

    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    if (!transfer) throw new BadRequestException('transfer missing');
    if (
      !this.isAddr(transfer.from) ||
      !this.isAddr(transfer.token) ||
      !this.isAddr(transfer.to)
    ) {
      throw new BadRequestException('transfer address invalid');
    }

    const chainId = await this.publicClient.getChainId();
    if (Number(chainId) !== Number(domain?.chainId)) {
      throw new BadRequestException('chainId mismatch');
    }
    if (!this.eqAddr(domain?.verifyingContract, process.env.DELEGATE_ADDRESS)) {
      throw new BadRequestException('verifyingContract must equal DELEGATE_ADDRESS (EIP-7702 contract)');
    }
    if (!this.eqAddr(transfer.from, authority)) {
      throw new BadRequestException('transfer.from must equal authority');
    }

    // EIP-712 서명 검증
    const transferData = {
      from: transfer.from as Address,
      token: transfer.token as Address,
      to: transfer.to as Address,
      amount: BigInt(String(transfer.amount)),
      nonce: BigInt(String(transfer.nonce)),
      deadline: BigInt(String(transfer.deadline ?? 0)),
    };

    const valid = await verifyTypedData({
      address: authority as Address,
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract as Address,
      },
      types: types as any,
      primaryType: 'Transfer',
      message: transferData as any,
      signature: signature712 as Hex,
    });

    if (!valid) {
      throw new BadRequestException({ code: 'BAD_712_SIGNATURE', authority });
    }

    // nextNonce 읽기
    const onchainNext = await this.readNextNonce(
      authority as Address,
      authorization?.signature ? {
        chainId: Number(authorization.chainId),
        address: authorization.address as Address,
        nonce: Number(authorization.nonce),
        signature: authorization.signature as Hex,
      } : undefined
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
    let bal: bigint;
    try {
      bal = await this.publicClient.readContract({
        address: transfer.token as Address,
        abi: [
          {
            name: 'balanceOf',
            type: 'function',
            inputs: [{ type: 'address' }],
            outputs: [{ type: 'uint256' }],
          },
        ],
        functionName: 'balanceOf',
        args: [authority as Address],
      }) as bigint;
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
    const calldata = encodeFunctionData({
      abi: this.DELEGATE_ABI,
      functionName: 'executeSignedTransfer',
      args: [
        {
          from: transfer.from as Address,
          token: transfer.token as Address,
          to: transfer.to as Address,
          amount: needed,
          nonce: tNonce,
          deadline: BigInt(String(transfer.deadline ?? 0)),
        },
        signature712 as Hex,
      ],
    });

    this.logger.debug(`[calldata] len=${(calldata.length - 2) / 2}B hash=${this.short(keccak256(calldata))}`);

    // authorizationList 구성
    const authList: Array<{
      chainId: number;
      address: Address;
      nonce: number;
      signature: Hex;
    }> = [];
    
    // Authorization이 있고 signature가 있는 경우만 EIP-7702 사용
    if (authorization?.signature && authorization.signature !== null) {
      if (!this.isAddr(authorization.address)) {
        throw new BadRequestException('authorization.address invalid');
      }
      authList.push({
        chainId: `0x${Number(authorization.chainId).toString(16)}` as any,
        address: authorization.address as Address,
        nonce: `0x${Number(authorization.nonce).toString(16)}` as any,
        signature: authorization.signature as Hex,
      });
      this.logger.debug(`[authorization] EIP-7702 사용: ${this.short(authorization.address)}`);
    } else {
      this.logger.debug(`[authorization] 일반 EOA 트랜잭션으로 처리`);
    }

    // simulate - EIP-7702 지원
    try {
      const callParams: any = {
        to: authority as Address,
        data: calldata,
      };
      
      // Authorization이 있으면 EIP-7702 call로 실행
      if (authList.length > 0) {
        callParams.type = 'eip7702';
        callParams.authorizationList = authList;
      }
      
      await this.publicClient.call(callParams);
      this.logger.log('[simulate] OK');
    } catch (e: any) {
      const parsed = this.decodeAndLogRevert(e, 'simulate');
      throw e;
    }

    // send - EIP-7702 지원
    const txParams: any = {
      to: authority as Address,
      data: calldata,
      chain: null,
    };
    
    // Authorization이 있으면 EIP-7702 transaction으로 실행
    if (authList.length > 0) {
      txParams.authorizationList = authList;
    }
    
    const txHash = await this.relayerClient.sendTransaction(txParams);

    this.logger.log(`[sent] txHash=${txHash}`);

    return { status: 'ok', txHash };
  }

  // MetaMask 결제 페이지 제공
  async getPaymentPage(token: string, to: string, amount: string, res: Response) {
    if (!token || !to || !amount) {
      throw new BadRequestException('Missing required parameters: token, to, amount');
    }

    const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>StableCoin Payment</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .payment-info {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            word-break: break-all;
        }
        .info-label {
            font-weight: bold;
            min-width: 80px;
        }
        button {
            width: 100%;
            padding: 15px;
            font-size: 16px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            margin-bottom: 10px;
        }
        .connect-btn {
            background: #ff6b35;
            color: white;
        }
        .connect-btn:hover {
            background: #e55a2e;
        }
        .pay-btn {
            background: #28a745;
            color: white;
        }
        .pay-btn:hover {
            background: #218838;
        }
        .pay-btn:disabled {
            background: #6c757d;
            cursor: not-allowed;
        }
        .status {
            text-align: center;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
        }
        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f1b0b7;
        }
        .status.info {
            background: #cce7ff;
            color: #004085;
            border: 1px solid #b3d7ff;
        }
        .loading {
            text-align: center;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🪙 StableCoin Payment</h1>
            <p>MetaMask를 사용하여 안전하게 결제하세요</p>
        </div>

        <div class="payment-info">
            <h3>결제 정보</h3>
            <div class="info-row">
                <span class="info-label">토큰:</span>
                <span id="tokenAddress">${token}</span>
            </div>
            <div class="info-row">
                <span class="info-label">받는주소:</span>
                <span id="toAddress">${to}</span>
            </div>
            <div class="info-row">
                <span class="info-label">금액:</span>
                <span id="amount">${amount}</span>
            </div>
        </div>

        <button id="connectBtn" class="connect-btn">MetaMask 연결</button>
        <button id="payBtn" class="pay-btn" disabled>결제하기</button>

        <div id="status"></div>
        <div id="loading" class="loading" style="display: none;">
            처리 중입니다...
        </div>
    </div>

    <!-- EventEmitter2 먼저 로드 -->
    <script src="https://cdn.jsdelivr.net/npm/eventemitter2@6.4.9/lib/eventemitter2.min.js"></script>
    
    <script type="module">
        import { 
            createWalletClient, 
            createPublicClient,
            custom, 
            http,
            encodeFunctionData, 
            decodeFunctionResult,
            verifyTypedData,
            getAddress
        } from 'https://esm.sh/viem@2.21.55';
        
        // EventEmitter2가 전역에 로드된 후 MetaMask SDK 로드 (안정적인 버전)
        import { MetaMaskSDK } from 'https://esm.sh/@metamask/sdk@0.26.5?external=eventemitter2';

        const CHAIN_ID = ${process.env.CHAIN_ID || 11155111};
        const DELEGATE_ADDRESS = "${process.env.DELEGATE_ADDRESS}";
        const SERVER_URL = "${process.env.SERVER_URL || 'http://localhost:4123'}";
        const RPC_URL = "${process.env.RPC_URL}";
        
        let MMSDK = null;
        let walletClient = null;
        let publicClient = null;
        let smartAccount = null;
        let userAccount = null;

        // DOM 요소들
        const connectBtn = document.getElementById('connectBtn');
        const payBtn = document.getElementById('payBtn');
        const statusDiv = document.getElementById('status');
        const loadingDiv = document.getElementById('loading');

        // URL 파라미터에서 결제 정보 가져오기
        const urlParams = new URLSearchParams(window.location.search);
        const paymentInfo = {
            token: urlParams.get('token') || '${token}',
            to: urlParams.get('to') || '${to}',
            amount: urlParams.get('amount') || '${amount}'
        };

        // ABI 정의
        const delegateAbi = [
            {
                name: 'nonce',
                type: 'function',
                inputs: [],
                outputs: [{ type: 'uint256' }],
            }
        ];

        // MetaMask 연결
        connectBtn.addEventListener('click', async () => {
            try {
                showLoading(true);
                
                // MetaMask SDK 초기화
                if (!MMSDK) {
                    MMSDK = new MetaMaskSDK({
                        dappMetadata: {
                            name: "StableCoin Payment",
                            url: window.location.href,
                        },
                        // 웹 환경에서는 확장 프로그램 우선 사용
                        extensionOnly: false,
                    });
                }

                // MetaMask 연결
                const accounts = await MMSDK.connect();
                if (!accounts || accounts.length === 0) {
                    throw new Error('계정을 찾을 수 없습니다.');
                }
                
                userAccount = accounts[0];
                
                // Provider 가져오기
                const provider = MMSDK.getProvider();
                
                // 네트워크 확인
                const chainId = await provider.request({ method: 'eth_chainId' });
                if (parseInt(chainId, 16) !== CHAIN_ID) {
                    showStatus('네트워크를 변경해주세요. 현재: ' + parseInt(chainId, 16) + ', 필요: ' + CHAIN_ID, 'error');
                    showLoading(false);
                    return;
                }

                // Public Client 생성
                publicClient = createPublicClient({
                    transport: http(RPC_URL),
                });

                // Wallet Client 생성
                walletClient = createWalletClient({
                    transport: custom(provider)
                });
                
                connectBtn.textContent = '연결됨: ' + userAccount.slice(0,6) + '...' + userAccount.slice(-4);
                connectBtn.disabled = true;
                payBtn.disabled = false;
                
                showStatus('MetaMask 연결이 완료되었습니다.', 'success');
                showLoading(false);
            } catch (error) {
                console.error('Connection error:', error);
                showStatus('연결 실패: ' + error.message, 'error');
                showLoading(false);
            }
        });

        // 결제 처리 (서버 기반 Authorization)
        payBtn.addEventListener('click', async () => {
            try {
                showLoading(true);
                showStatus('서버에서 가스리스 결제를 처리하고 있습니다...', 'info');

                // 1. Contract nonce 읽기 (간소화된 방법)
                console.log('🔢 Nonce 읽기 중...');
                
                let nextNonce;
                try {
                    // storage slot에서 직접 읽기 (간단한 방법)
                    const provider = MMSDK.getProvider();
                    const raw = await provider.request({
                        method: 'eth_getStorageAt',
                        params: [userAccount, '0x0', 'latest']
                    });
                    nextNonce = BigInt(raw || 0);
                    console.log('✅ Storage slot nonce:', nextNonce.toString());
                } catch (e) {
                    console.warn('⚠️ Storage slot 읽기 실패, nonce 0 사용:', e?.message);
                    nextNonce = BigInt(0);
                }

                // 2. EIP-712 서명 생성
                console.log('✍️ EIP-712 서명 생성 중...');
                
                const domain = {
                    name: 'DelegatedTransfer',
                    version: '1',
                    chainId: CHAIN_ID,
                    verifyingContract: DELEGATE_ADDRESS, // 위임된 컨트랙트 주소 (EIP-7702 요구사항)
                };

                const types = {
                    Transfer: [
                        { name: 'from', type: 'address' },
                        { name: 'token', type: 'address' },
                        { name: 'to', type: 'address' },
                        { name: 'amount', type: 'uint256' },
                        { name: 'nonce', type: 'uint256' }, // == nextNonce
                        { name: 'deadline', type: 'uint256' },
                    ],
                };

                const transfer = {
                    from: userAccount,
                    token: paymentInfo.token,
                    to: paymentInfo.to,
                    amount: BigInt(paymentInfo.amount),
                    nonce: nextNonce,
                    deadline: BigInt(Math.floor(Date.now() / 1000) + 300), // 5분
                };

                // viem의 signTypedData 사용
                const signature712 = await walletClient.signTypedData({
                    account: userAccount,
                    domain,
                    types,
                    primaryType: 'Transfer',
                    message: transfer,
                });

                console.log('✅ EIP-712 서명 완료');

                // 3. 서버로 전송 (Authorization은 서버에서 완전히 처리됨)
                console.log('🌐 서버로 가스리스 결제 요청 전송 중...');
                
                const body = {
                    authority: userAccount,
                    transfer: {
                        from: transfer.from,
                        token: transfer.token,
                        to: transfer.to,
                        amount: transfer.amount.toString(),
                        nonce: transfer.nonce.toString(),
                        deadline: transfer.deadline.toString(),
                    },
                    domain,
                    types,
                    signature712,
                    // Authorization은 완전히 서버에서 처리되므로 제거됨
                };

                // 새로운 서버 기반 엔드포인트 사용
                const response = await fetch(SERVER_URL + '/server-payment', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                });

                const result = await response.json();

                if (response.ok && result.status === 'ok') {
                    showStatus('🎉 가스리스 결제가 완료되었습니다! 트랜잭션: ' + result.txHash, 'success');
                    console.log('🔐 서버에서 생성된 Authorization:', result.authorization);
                } else {
                    throw new Error(result.message || '결제에 실패했습니다.');
                }

            } catch (error) {
                console.error('Payment error:', error);
                showStatus('결제 실패: ' + error.message, 'error');
            } finally {
                showLoading(false);
            }
        });

        function showStatus(message, type) {
            statusDiv.innerHTML = message;
            statusDiv.className = 'status ' + type;
            statusDiv.style.display = 'block';
        }

        function showLoading(show) {
            loadingDiv.style.display = show ? 'block' : 'none';
        }

        // 페이지 로드시 초기화
        window.addEventListener('load', () => {
            showStatus('MetaMask SDK를 준비 중입니다. 연결 버튼을 클릭하세요.', 'info');
        });
    </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
}
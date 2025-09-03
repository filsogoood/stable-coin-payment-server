// app.service.ts
import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import { ethers, Interface } from 'ethers';
import { spawn } from 'child_process';
import * as path from 'path';
import axios from 'axios';

type Hex = `0x${string}`;

type AuthItem = {
  chainId: number;
  address: string;
  nonce: number;
  signature: Hex;
};

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
export class AppService implements OnModuleInit {
  private readonly logger = new Logger('AppService');
  
  // 인쇄 대기열 (메모리 기반 저장소)
  private printQueue: PrintQueueItem[] = [];
  
  // QR 스캔 세션 저장소 (실제 운영에서는 Redis 등 사용 권장)
  private sessionStorage = new Map<string, any>();
  
  // EIP-7702 지원 여부 캐시
  private eip7702SupportCache: boolean | null = null;

  private provider!: ethers.JsonRpcProvider;
  private relayer!: ethers.Wallet;

  // ERC20 토큰 ABI (잔액 조회용)
  private readonly ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
  ] as const;

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

  async onModuleInit() {
    const RPC_URL  = process.env.RPC_URL!;
    const CHAIN_ID = Number(process.env.CHAIN_ID!);
    const SPONSOR  = process.env.SPONSOR_PK!;
    if (!RPC_URL)  throw new Error('RPC_URL missing');
    if (!CHAIN_ID) throw new Error('CHAIN_ID missing');
    if (!SPONSOR)  throw new Error('SPONSOR_PK missing');

    const staticNet = { name: CHAIN_ID === 97 ? 'bsc-testnet' : (CHAIN_ID === 56 ? 'bsc' : 'custom'), chainId: CHAIN_ID };
    this.provider = new ethers.JsonRpcProvider(RPC_URL, staticNet);

    const rpcId = Number(await this.provider.send('eth_chainId', []));
    if (rpcId !== CHAIN_ID) throw new Error(`RPC chainId(${rpcId}) != env CHAIN_ID(${CHAIN_ID})`);
    this.logger.log(`[RPC_OK] chainId=${rpcId}`);

    this.relayer = new ethers.Wallet(SPONSOR, this.provider);
    const bal = await this.provider.getBalance(this.relayer.address);
    this.logger.log(`[RELAYER] ${this.relayer.address} balance=${ethers.formatEther(bal)} BNB`);
  }

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

  /**
   * EIP-7702 지원 여부를 확인 (캐싱 적용)
   */
  private async checkEIP7702Support(): Promise<boolean> {
    // 캐시된 결과가 있다면 로그만 출력하고 반환
    if (this.eip7702SupportCache !== null) {
      if (this.eip7702SupportCache) {
        this.logger.log('[EIP7702_CHECK] ✅ EIP-7702가 지원됩니다 (캐시됨)');
      } else {
        this.logger.warn('[EIP7702_CHECK] ❌ EIP-7702가 지원되지 않습니다 (캐시됨)');
      }
      return this.eip7702SupportCache;
    }

    try {
      this.logger.log('[EIP7702_CHECK] EIP-7702 지원 여부 확인 시작');
      
      const network = await this.provider.getNetwork();
      const chainId = Number(network?.chainId || 97);
      
      // 알려진 EIP-7702 미지원 네트워크 확인 (BSC는 지원한다고 하니 제외)
      const unsupportedChainIds = [
        // 56,     // BSC Mainnet - 사용자가 지원한다고 확인
        // 97,     // BSC Testnet - 사용자가 지원한다고 확인
        137,    // Polygon Mainnet
        80001,  // Polygon Mumbai (deprecated)
        80002,  // Polygon Amoy
        43114,  // Avalanche C-Chain
        43113,  // Avalanche Fuji Testnet
        250,    // Fantom Opera
        4002,   // Fantom Testnet
        25,     // Cronos Mainnet
        338,    // Cronos Testnet
        1284,   // Moonbeam
        1287,   // Moonriver
        42161,  // Arbitrum One
        421613, // Arbitrum Goerli (deprecated)
        421614, // Arbitrum Sepolia
        10,     // Optimism
        420,    // Optimism Goerli (deprecated)
        11155420, // Optimism Sepolia
      ];
      
      if (unsupportedChainIds.includes(chainId)) {
        this.logger.warn(`[EIP7702_CHECK] ❌ EIP-7702가 지원되지 않습니다 (Chain ID ${chainId}는 알려진 미지원 네트워크)`);
        this.eip7702SupportCache = false;
        return false;
      }
      
      // 간단한 EIP-7702 트랜잭션으로 테스트
      const testAuth = {
        chainId: chainId,
        address: '0x0000000000000000000000000000000000000001', // 테스트용 주소
        nonce: 0,
        signature: '0x' + '00'.repeat(65), // 테스트용 시그니처
      };

      await this.provider.call({
        to: '0x0000000000000000000000000000000000000001',
        data: '0x',
        type: 4,
        authorizationList: [testAuth],
      } as any);

      this.logger.log('[EIP7702_CHECK] ✅ EIP-7702가 지원됩니다');
      this.eip7702SupportCache = true;
      return true;
      
    } catch (e: any) {
      this.logger.log('[EIP7702_CHECK] EIP-7702 테스트 실패:', e.message);
      
      // EIP-7702 미지원을 나타내는 에러 메시지들
      const errorMessage = e.message?.toLowerCase() || '';
      const errorInfo = e.info?.error?.message?.toLowerCase() || '';
      
      if (
        errorMessage.includes('invalid opcode') || 
        errorMessage.includes('opcode 0xef') ||
        errorMessage.includes('unknown transaction type') ||
        errorMessage.includes('transaction type not supported') ||
        errorMessage.includes('transaction type 4') ||
        errorInfo.includes('invalid opcode') ||
        errorInfo.includes('opcode 0xef')
      ) {
        this.logger.warn('[EIP7702_CHECK] ❌ EIP-7702가 지원되지 않습니다 (네트워크 미지원)');
        this.eip7702SupportCache = false;
        return false;
      }
      
      // 다른 에러도 EIP-7702 미지원으로 간주 (보수적 접근)
      this.logger.warn('[EIP7702_CHECK] ❌ EIP-7702가 지원되지 않습니다 (테스트 실패)');
      this.eip7702SupportCache = false;
      return false;
    }
  }

  // ─────────────────────────────────────────
  // nextNonce: 우선 auth-context view, 실패 시 slot0
  // ─────────────────────────────────────────
  // slot0 읽기 (fallback)
  private async readNextNonceViaStorage(authority: string): Promise<bigint> {
    this.logger.debug('[STORAGE_NONCE] Slot0에서 nonce 조회 시작:', authority);
    const raw = await this.provider.getStorage(authority, 0);
    const nonce = BigInt(raw || 0);
    this.logger.debug('[STORAGE_NONCE] Slot0 조회 결과:', { raw, nonce: nonce.toString() });
    return nonce;
  }

  // authorizationList를 사용해 authority에서 nonce() view 호출
  private async readNextNonceViaAuthorizedView(
    authority: string,
    authItem: AuthItem
  ): Promise<bigint> {
    this.logger.debug('[AUTH_VIEW_NONCE] Authorization context nonce 조회 시작:', {
      authority,
      authItemAddress: authItem.address,
      authItemNonce: authItem.nonce,
      authItemChainId: authItem.chainId
    });

    const iface = new ethers.Interface(['function nonce() view returns (uint256)']);
    const data  = iface.encodeFunctionData('nonce', []);

    // ✅ ethers v6: call은 인자 1개만. 'latest' 제거
    const ret = await this.provider.call({
      to: authority,
      data,
      // ★ EIP-7702 컨텍스트
      type: 4,
      authorizationList: [authItem] as any,
    } as any);

    // ✅ decode 결과는 ethers.Result. 안전하게 꺼내서 bigint로 캐스팅
    const decoded = iface.decodeFunctionResult('nonce', ret);
    const nextNonce = decoded[0] as bigint; // v6에서 uint256 -> bigint
    
    this.logger.debug('[AUTH_VIEW_NONCE] Authorization context nonce 조회 성공:', {
      rawResult: ret,
      decoded: decoded.toString(),
      nextNonce: nextNonce.toString()
    });
    
    return nextNonce;
  }

  // nextNonce 읽기: 우선 authorized view → 실패 시 slot0 폴백
  private async readNextNonce(authority: string, authItem?: AuthItem): Promise<bigint> {
    this.logger.debug('[READ_NEXT_NONCE] Nonce 조회 시작:', { 
      authority, 
      hasAuthItem: !!authItem,
      authItemAddress: authItem?.address 
    });

    if (authItem) {
      this.logger.debug('[READ_NEXT_NONCE] Authorization context 사용하여 nonce 조회 시도');
      try {
        const nonce = await this.readNextNonceViaAuthorizedView(authority, authItem);
        this.logger.debug('[READ_NEXT_NONCE] Authorization context 조회 성공:', nonce);
        return nonce;
      } catch (e: any) {
        this.logger.warn('[READ_NEXT_NONCE] Authorization context 조회 실패, slot0 폴백 사용:', e?.shortMessage || e?.message || e);
        const fallbackNonce = await this.readNextNonceViaStorage(authority);
        this.logger.debug('[READ_NEXT_NONCE] Slot0 fallback 결과:', fallbackNonce);
        return fallbackNonce;
      }
    }
    
    this.logger.debug('[READ_NEXT_NONCE] Authorization 없음, slot0 직접 조회');
    const nonce = await this.readNextNonceViaStorage(authority);
    this.logger.debug('[READ_NEXT_NONCE] Slot0 직접 조회 결과:', nonce);
    return nonce;
  }

  async getNextNonce(authority: string, authorization?: AuthItem) {
    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    const next = await this.readNextNonce(authority, authorization);
    return { authority, nextNonce: next.toString(), via: authorization ? 'view-or-slot' : 'slot' };
  }

  // ─────────────────────────────────────────
  // 메인 실행 (중요 부분만 수정)
  // ─────────────────────────────────────────
  async payment(body: any) {
    const { authority, transfer, domain, types, signature712, authorization } = body ?? {};
    this.logger.debug(`[PAYMENT_DEBUG] Received payment request:`, {
      authority,
      transfer: transfer ? {
        from: transfer.from,
        token: transfer.token,
        to: transfer.to,
        amount: transfer.amount,
        nonce: transfer.nonce,
        deadline: transfer.deadline
      } : null,
      domain: domain ? {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract
      } : null,
      authorization: authorization ? {
        chainId: authorization.chainId,
        address: authorization.address,
        nonce: authorization.nonce,
        signature: authorization.signature ? 
          (typeof authorization.signature === 'string' ? 
            authorization.signature.substring(0, 20) + '...' : 
            authorization.signature.serialized ? authorization.signature.serialized.substring(0, 20) + '...' : '[Signature Object]'
          ) : null
      } : null,
      signature712: signature712 ? signature712.substring(0, 20) + '...' : null
    });

    this.logger.debug(`[ADDRESS_DEBUG] authority=${authority}`);
    
    if (!this.isAddr(authority)) {
      this.logger.error(`[PAYMENT_ERROR] Invalid authority address: ${authority}`);
      throw new BadRequestException('authority invalid');
    }
    if (!transfer) {
      this.logger.error('[PAYMENT_ERROR] Transfer data missing');
      throw new BadRequestException('transfer missing');
    }

    // 체인 ID 검증
    this.logger.debug(`[PAYMENT_DEBUG] Chain ID 검증 시작: domain.chainId=${domain?.chainId}`);
    const rpcId = Number(await this.provider.send('eth_chainId', []));
    this.logger.debug(`[PAYMENT_DEBUG] RPC chainId=${rpcId}, domain.chainId=${Number(domain?.chainId)}`);
    if (rpcId !== Number(domain?.chainId)) {
      this.logger.error(`[PAYMENT_ERROR] Chain ID mismatch: rpc=${rpcId}, domain=${Number(domain?.chainId)}`);
      throw new BadRequestException('chainId mismatch');
    }
    this.logger.debug('[PAYMENT_DEBUG] Chain ID 검증 통과');

    // EIP-712 서명 검증
    this.logger.debug('[PAYMENT_DEBUG] EIP-712 서명 검증 시작');
    this.logger.debug(`[PAYMENT_DEBUG] Transfer data: ${JSON.stringify(transfer)}`);
    this.logger.debug(`[PAYMENT_DEBUG] Domain: ${JSON.stringify(domain)}`);
    this.logger.debug(`[PAYMENT_DEBUG] Signature712: ${signature712?.substring(0, 20)}...`);
    
    let recovered: string;
    try {
      recovered = ethers.verifyTypedData(
        domain, types,
        {
          from: transfer.from,
          token: transfer.token,
          to:   transfer.to,
          amount: BigInt(transfer.amount),
          nonce:  BigInt(transfer.nonce),
          deadline: BigInt(transfer.deadline ?? 0),
        },
        signature712
      );
      this.logger.debug(`[PAYMENT_DEBUG] EIP-712 서명 검증 성공: recovered=${recovered}`);
    } catch (sigError: any) {
      this.logger.error(`[PAYMENT_ERROR] EIP-712 서명 검증 실패: ${sigError.message}`);
      throw new BadRequestException(`EIP-712 서명 검증 실패: ${sigError.message}`);
    }
    
    if (!this.eqAddr(recovered, authority)) {
      this.logger.error(`[PAYMENT_ERROR] 서명자 주소 불일치: recovered=${recovered}, authority=${authority}`);
      throw new BadRequestException({ code: 'BAD_712_SIGNER', recovered, authority });
    }
    this.logger.debug('[PAYMENT_DEBUG] 서명자 주소 검증 통과');

    // ★ EOA transaction nonce 검증 (EIP-7702는 EOA nonce 사용)
    this.logger.debug('[PAYMENT_DEBUG] Nonce 검증 시작 - EOA transaction nonce 사용');
    const onchainEOANonce = await this.provider.getTransactionCount(authority, 'latest');
    const tNonce = BigInt(transfer.nonce);
    this.logger.debug(`[PAYMENT_DEBUG] EOA nonce=${onchainEOANonce}, transfer nonce=${tNonce}`);
    if (BigInt(onchainEOANonce) !== tNonce) {
      this.logger.error(`[PAYMENT_ERROR] EOA nonce 불일치: got=${tNonce}, expected=${onchainEOANonce}`);
      throw new BadRequestException({
        code: 'BAD_NONCE',
        got: tNonce.toString(),
        expected: onchainEOANonce.toString(),
      });
    }
    this.logger.debug('[PAYMENT_DEBUG] EOA nonce 검증 통과');

    // 잔고 체크 (best-effort)
    const erc20 = new ethers.Contract(
      transfer.token,
      [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ],
      this.provider
    );
    let bal: bigint = 0n;
    try {
      const b = await erc20.balanceOf(authority);
      bal = BigInt(b.toString());
    } catch { /* ignore */ }
    const needed = BigInt(String(transfer.amount));
    if (bal < needed) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        balance: bal.toString(),
        needed: needed.toString(),
      });
    }

    // calldata
    const calldata = this.delegateIface.encodeFunctionData('executeSignedTransfer', [
      {
        from: transfer.from,
        token: transfer.token,
        to:   transfer.to,
        amount: needed,
        nonce:  tNonce,
        deadline: BigInt(String(transfer.deadline ?? 0)),
      },
      signature712,
    ]);
    this.logger.debug(`[calldata] len=${(calldata.length-2)/2}B hash=${this.short(ethers.keccak256(calldata))}`);

    // authList
    const authList: Array<{ chainId:number; address:string; nonce:number; signature:Hex; }> = [];
    if (authorization?.signature) {
      // signature가 객체인 경우 문자열로 변환
      const signatureString = typeof authorization.signature === 'string' 
        ? authorization.signature 
        : authorization.signature.serialized || ethers.Signature.from(authorization.signature).serialized;
        
      this.logger.debug('[AUTHORIZATION_DEBUG] Processing authorization:', {
        chainId: authorization.chainId,
        address: authorization.address,
        nonce: authorization.nonce,
        signature: signatureString.substring(0, 20) + '...',
        isValidAddress: this.isAddr(authorization.address),
        signatureType: typeof authorization.signature
      });
      
      if (!this.isAddr(authorization.address)) {
        this.logger.error(`[AUTHORIZATION_ERROR] Invalid authorization address: ${authorization.address}`);
        throw new BadRequestException('authorization.address invalid');
      }
      authList.push({
        chainId: Number(authorization.chainId),
        address: authorization.address,
        nonce:   Number(authorization.nonce),
        signature: signatureString as Hex,
      });
      this.logger.debug(`[AUTHORIZATION_SUCCESS] Authorization added to authList with signature:`, signatureString.substring(0, 20) + '...');
    } else {
      this.logger.error('[AUTHORIZATION_ERROR] Authorization missing or no signature');
      throw new BadRequestException('authorization missing');
    }

    // simulate (선택): 실패해도 치명적 X
    try {
      await this.provider.call({
        to: authority,
        data: calldata,
        type: 4,
        authorizationList: authList,
      } as any);
      this.logger.log('[simulate] OK');
    } catch (e:any) {
      this.logger.warn('[simulate] skipped (auth-call may be unsupported on this RPC)');
      this.decodeAndLogRevert(e, 'simulate');
    }

    // ── 수수료 설정: EIP-1559 우선, 미지원시 legacy
    const MIN_TIP = ethers.parseUnits('1', 'gwei'); // 1 gwei
    const fee = await this.provider.getFeeData();
    const latest = await this.provider.getBlock('latest');

    const base = latest?.baseFeePerGas
      ?? fee.gasPrice
      ?? ethers.parseUnits('1', 'gwei');

    const tip = (fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas >= MIN_TIP)
      ? fee.maxPriorityFeePerGas
      : MIN_TIP;

    const supports1559 = (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) || latest?.baseFeePerGas != null;

    const maxFee = (latest?.baseFeePerGas != null)
      ? (latest.baseFeePerGas * 2n + tip)
      : (base + tip);

    const txReq: any = {
      to: authority,
      data: calldata,
      type: 4 as any,
      authorizationList: authList,
      customData: { authorizationList: authList },
    };

    if (supports1559) {
      txReq.maxPriorityFeePerGas = tip;
      txReq.maxFeePerGas = maxFee;
    } else {
      txReq.gasPrice = base + tip; // 최소 2 gwei 근처
    }

    // (선택) gasLimit 추정(+20%)
    try {
      const est = await this.provider.estimateGas({
        to: txReq.to,
        data: txReq.data,
        type: txReq.type,
        authorizationList: txReq.authorizationList,
        maxPriorityFeePerGas: txReq.maxPriorityFeePerGas,
        maxFeePerGas: txReq.maxFeePerGas,
        gasPrice: txReq.gasPrice,
      } as any);
      txReq.gasLimit = (est * 120n) / 100n;
    } catch {
      // 추정 실패 시 노드 추정에 맡김
    }

    this.logger.debug(
      `[send] mode=${supports1559 ? '1559' : 'legacy'}, ` +
      (supports1559
        ? `tip=${ethers.formatUnits(tip,'gwei')} gwei, maxFee=${ethers.formatUnits(maxFee,'gwei')} gwei`
        : `gasPrice=${ethers.formatUnits(txReq.gasPrice,'gwei')} gwei`
      ) + `, auths=${authList.length}`
    );

    const tx = await this.relayer.sendTransaction(txReq);
    this.logger.log(`[sent] hash=${tx.hash}`);

    // 60초 타임아웃 race
    const timeoutMs = 60_000;
    const result = await Promise.race([
      tx.wait(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('WAIT_TIMEOUT')), timeoutMs)),
    ]).catch((e) => e);

    if (result instanceof Error) {
      this.logger.warn(`[wait] ${result.message}; returning pending hash`);
      return { status: 'pending', txHash: tx.hash };
    } else {
      const rc = result as ethers.TransactionReceipt;
      this.logger.log(`[mined] status=${rc.status} gasUsed=${rc.gasUsed?.toString()}`);
      return { status: rc.status === 1 ? 'ok' : 'reverted', txHash: tx.hash };
    }
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
      'rpcUrl',
      'privateKey', // QR 스캔된 개인키 필수
    ];
    for (const field of requiredFields) {
      if (!qrData[field]) {
        throw new BadRequestException(`${field} 필드가 없습니다.`);
      }
    }

    // 타임스탬프 검증 제거 - QR 코드는 상시 사용 가능해야 함

    this.logger.log(`[GASLESS_PAYMENT] QR 스캔 결제 요청 시작`);

    // QR 스캔된 개인키 검증 및 주소 계산
    let derivedAddress: string;
    try {
      const wallet = new ethers.Wallet(qrData.privateKey);
      derivedAddress = wallet.address;
      this.logger.log(`[GASLESS_PAYMENT] QR 개인키에서 파생된 주소: ${derivedAddress}`);
    } catch (error: any) {
      this.logger.error(`[GASLESS_PAYMENT] 잘못된 개인키: ${error.message}`);
      throw new BadRequestException(`잘못된 개인키입니다: ${error.message}`);
    }

    // 환경변수 임시 설정
    const originalEnv = {
      TOKEN: process.env.TOKEN,
      TO: process.env.TO,
      AMOUNT_WEI: process.env.AMOUNT_WEI,
      CHAIN_ID: process.env.CHAIN_ID,
      DELEGATE_ADDRESS: process.env.DELEGATE_ADDRESS,
      RPC_URL: process.env.RPC_URL,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
    };

    try {
      // QR 데이터로 환경변수 임시 변경
      process.env.TOKEN = qrData.token;
      process.env.TO = qrData.to;
      process.env.AMOUNT_WEI = qrData.amountWei;
      process.env.CHAIN_ID = qrData.chainId.toString();
      process.env.DELEGATE_ADDRESS = qrData.delegateAddress; // QR 데이터의 delegate 컨트랙트 주소 사용
      process.env.RPC_URL = qrData.rpcUrl;
      process.env.PRIVATE_KEY = qrData.privateKey; // QR 스캔된 개인키 사용

      this.logger.log(`[GASLESS_PAYMENT] 환경변수 설정 완료:`);
      this.logger.log(`- TOKEN: ${process.env.TOKEN}`);
      this.logger.log(`- TO: ${process.env.TO}`);
      this.logger.log(`- AMOUNT_WEI: ${process.env.AMOUNT_WEI}`);
      this.logger.log(`- CHAIN_ID: ${process.env.CHAIN_ID}`);
      this.logger.log(`- DELEGATE_ADDRESS: ${process.env.DELEGATE_ADDRESS}`);
      this.logger.log(`- PRIVATE_KEY: ${qrData.privateKey.substring(0, 10)}...`);
      this.logger.log(`- RPC_URL: ${process.env.RPC_URL}`);

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
                  productName: qrData.productName || '기타', // QR 데이터에서 상품명 사용, 없으면 기본값
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
                  message: '결제가 성공적으로 처리되었습니다.',
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
                message: '결제가 처리되었습니다.',
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
    this.logger.log('[STORE_PRIVATE_KEY] 개인키 세션 저장 시작');
    
    const { type, sessionId, encryptedPrivateKey, expiresAt } = body;
    
    this.logger.debug('[STORE_PRIVATE_KEY] 요청 데이터:', {
      type,
      sessionId,
      hasEncryptedPrivateKey: !!encryptedPrivateKey,
      expiresAt
    });

    if (type !== 'private_key_session') {
      this.logger.error('[STORE_PRIVATE_KEY] 잘못된 QR 코드 타입:', type);
      throw new BadRequestException('잘못된 QR 코드 타입입니다.');
    }

    if (!sessionId || !encryptedPrivateKey) {
      this.logger.error('[STORE_PRIVATE_KEY] 필수 데이터 누락:', {
        hasSessionId: !!sessionId,
        hasEncryptedPrivateKey: !!encryptedPrivateKey
      });
      throw new BadRequestException('필수 데이터가 누락되었습니다.');
    }

    // 만료 시간 확인
    const now = new Date();
    const expiry = new Date(expiresAt);
    this.logger.debug('[STORE_PRIVATE_KEY] 만료 시간 확인:', {
      now: now.toISOString(),
      expiresAt: expiry.toISOString(),
      isExpired: expiry <= now
    });
    
    if (expiry <= now) {
      this.logger.error('[STORE_PRIVATE_KEY] 만료된 QR 코드:', {
        expiresAt: expiry.toISOString(),
        now: now.toISOString()
      });
      throw new BadRequestException('만료된 QR 코드입니다.');
    }

    // 세션 저장
    const storedAt = new Date().toISOString();
    this.sessionStorage.set(sessionId, {
      encryptedPrivateKey,
      expiresAt,
      storedAt,
    });

    this.logger.log('[STORE_PRIVATE_KEY] 세션 저장 완료:', {
      sessionId,
      storedAt,
      totalSessions: this.sessionStorage.size
    });

    const result = {
      status: 'success',
      message: '개인키 세션이 저장되었습니다.',
      sessionId,
    };
    
    this.logger.log('[STORE_PRIVATE_KEY] 개인키 세션 저장 성공');
    return result;
  }

  // QR 스캔 결제 - 결제 실행
  async scanPayment(body: any) {
    this.logger.log('[SCAN_PAYMENT] QR 스캔 결제 실행 시작');
    
    const { type, sessionId, recipient, amount, token, productName } = body;
    
    this.logger.debug('[SCAN_PAYMENT] 요청 데이터:', {
      type,
      sessionId,
      recipient,
      amount,
      token,
      productName
    });

    if (type !== 'payment_request') {
      this.logger.error('[SCAN_PAYMENT] 잘못된 QR 코드 타입:', type);
      throw new BadRequestException('잘못된 QR 코드 타입입니다.');
    }

    if (!sessionId || !recipient || !amount || !token) {
      const missingFields: string[] = [];
      if (!sessionId) missingFields.push('sessionId');
      if (!recipient) missingFields.push('recipient');
      if (!amount) missingFields.push('amount');
      if (!token) missingFields.push('token');
      
      this.logger.error('[SCAN_PAYMENT] 필수 결제 정보 누락:', missingFields);
      throw new BadRequestException('필수 결제 정보가 누락되었습니다.');
    }

    this.logger.log('[SCAN_PAYMENT] 세션 확인 시작:', sessionId);
    
    // 세션 확인
    const session = this.sessionStorage.get(sessionId);
    if (!session) {
      this.logger.error('[SCAN_PAYMENT] 세션을 찾을 수 없음:', {
        sessionId,
        totalSessions: this.sessionStorage.size
      });
      throw new BadRequestException('세션을 찾을 수 없습니다. 개인키 QR을 다시 스캔해주세요.');
    }
    
    this.logger.log('[SCAN_PAYMENT] 세션 찾기 성공:', {
      sessionId,
      storedAt: session.storedAt
    });

    // 세션 만료 확인
    const now = new Date();
    const expiry = new Date(session.expiresAt);
    
    this.logger.debug('[SCAN_PAYMENT] 세션 만료 시간 확인:', {
      now: now.toISOString(),
      expiresAt: expiry.toISOString(),
      isExpired: expiry <= now
    });
    
    if (expiry <= now) {
      this.sessionStorage.delete(sessionId);
      this.logger.error('[SCAN_PAYMENT] 세션 만료로 인한 삭제:', {
        sessionId,
        expiresAt: expiry.toISOString(),
        now: now.toISOString()
      });
      throw new BadRequestException('세션이 만료되었습니다. 개인키 QR을 다시 스캔해주세요.');
    }

    try {
      this.logger.log('[SCAN_PAYMENT] 실제 결제 로직 시작:', {
        sessionId,
        amount,
        recipient,
        token
      });

      // 여기서 실제 결제 로직 실행
      // 기존 payment 메서드와 유사한 로직을 사용하되, 개인키는 세션에서 가져옴
      
      this.logger.debug('[SCAN_PAYMENT] 더미 트랜잭션 해시 생성 중...');
      // 임시로 성공 응답 (실제로는 블록체인 거래 처리)
      const txHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
      
      this.logger.debug('[SCAN_PAYMENT] 더미 트랜잭션 해시 생성:', txHash);
      
      const timestamp = new Date().toISOString();
      const paymentResult = {
        status: 'success',
        txHash,
        amount,
        token,
        recipient,
        sessionId,
        timestamp,
      };
      
      this.logger.log('[SCAN_PAYMENT] 더미 결제 결과 생성:', paymentResult);

      // 결제 성공 후 영수증 인쇄 호출
      this.logger.log('[SCAN_PAYMENT] 영수증 인쇄 요청 시작');
      
      try {
        const receiptData = {
          txHash: paymentResult.txHash,
          amount: paymentResult.amount,
          token: paymentResult.token,
          from: 'QR_SCAN_USER', // QR 스캔 결제의 경우
          to: paymentResult.recipient,
          timestamp: paymentResult.timestamp,
          status: 'success',
          productName: productName || '기타', // QR 데이터에서 상품명 사용, 없으면 기본값
          sessionId: paymentResult.sessionId,
        };
        
        await this.printReceipt(receiptData);
        this.logger.log('[SCAN_PAYMENT] 영수증 인쇄 요청 성공');
      } catch (printError: any) {
        this.logger.warn('[SCAN_PAYMENT] 영수증 인쇄 실패:', {
          error: printError.message,
          txHash: paymentResult.txHash
        });
        // 영수증 인쇄 실패해도 결제 성공은 유지
      }

      // 세션 정리
      this.sessionStorage.delete(sessionId);
      this.logger.log('[SCAN_PAYMENT] 세션 정리 완료:', {
        sessionId,
        remainingSessions: this.sessionStorage.size
      });

      this.logger.log('[SCAN_PAYMENT] QR 스캔 결제 전체 완료:', {
        txHash,
        sessionId,
        amount,
        recipient
      });

      const finalResult = {
        paymentResult,
        status: 'success',
        message: '2단계 QR 스캔 결제가 완료되었습니다.',
      };
      
      this.logger.log('[SCAN_PAYMENT] 최종 응답 반환:', finalResult);
      return finalResult;

    } catch (error: any) {
      this.logger.error('[SCAN_PAYMENT] 결제 처리 실패:', {
        error: error.message,
        stack: error.stack,
        sessionId,
        amount,
        recipient,
        token
      });
      throw new BadRequestException(`결제 처리 실패: ${error.message}`);
    }
  }

  // 영수증 인쇄 요청 (대기열에 저장)
  async printReceipt(receiptData: ReceiptData) {
    this.logger.log('[PRINT_RECEIPT] 영수증 인쇄 요청 시작');
    this.logger.debug('[PRINT_RECEIPT] 영수증 데이터:', {
      txHash: receiptData.txHash,
      amount: receiptData.amount,
      token: receiptData.token,
      from: receiptData.from,
      to: receiptData.to,
      status: receiptData.status,
      productName: receiptData.productName,
      sessionId: receiptData.sessionId
    });
    
    try {

      this.logger.log('[PRINT_RECEIPT] 인쇄 대기열 아이템 생성 시작');
      
      // 인쇄 대기열 아이템 생성
      const printId = `print_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const createdAt = new Date().toISOString();
      
      const printItem: PrintQueueItem = {
        id: printId,
        receiptData,
        createdAt,
        status: 'pending',
        attemptCount: 0,
      };
      
      this.logger.debug('[PRINT_RECEIPT] 인쇄 아이템 생성 완료:', {
        id: printItem.id,
        txHash: receiptData.txHash,
        status: printItem.status
      });

      // 대기열에 추가
      this.printQueue.push(printItem);
      
      this.logger.log('[PRINT_RECEIPT] 인쇄 대기열에 추가 완료:', {
        printId: printItem.id,
        txHash: receiptData.txHash,
        queueSize: this.printQueue.length
      });

      const result = {
        status: 'success',
        message: '영수증이 인쇄 대기열에 추가되었습니다.',
        printJobId: printItem.id,
        queueSize: this.printQueue.length,
      };
      
      this.logger.log('[PRINT_RECEIPT] 영수증 인쇄 요청 성공적으로 완료');
      return result;

    } catch (error: any) {
      this.logger.error('[PRINT_RECEIPT] 영수증 인쇄 오류:', {
        error: error.message,
        stack: error.stack,
        txHash: receiptData.txHash
      });
      throw new BadRequestException(`영수증 인쇄 대기열 추가 실패: ${error.message}`);
    }
  }

  // 인쇄 대기열 조회 (Android APP에서 폴링)
  async getPrintQueue() {
    this.logger.debug('[GET_PRINT_QUEUE] 인쇄 대기열 조회 시작');
    
    try {
      // pending 상태인 아이템들만 반환
      const pendingItems = this.printQueue.filter(item => item.status === 'pending');
      
      this.logger.debug('[GET_PRINT_QUEUE] 대기열 상태:', {
        total: this.printQueue.length,
        pending: pendingItems.length,
        printing: this.printQueue.filter(item => item.status === 'printing').length,
        completed: this.printQueue.filter(item => item.status === 'completed').length,
        failed: this.printQueue.filter(item => item.status === 'failed').length
      });
      
      const result = {
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
          productName: item.receiptData.productName || '기타', // 상품명 추가
          createdAt: item.createdAt,
          attemptCount: item.attemptCount,
        })),
      };
      
      this.logger.debug('[GET_PRINT_QUEUE] 대기열 조회 완료:', {
        totalItems: result.totalItems,
        pendingItems: result.pendingItems
      });
      
      return result;

    } catch (error: any) {
      this.logger.error('[GET_PRINT_QUEUE] 대기열 조회 오류:', {
        error: error.message,
        stack: error.stack
      });
      throw new BadRequestException(`인쇄 대기열 조회 실패: ${error.message}`);
    }
  }

  // 인쇄 작업 상태 업데이트
  async updatePrintStatus(printId: string, status: 'printing' | 'completed' | 'failed', errorMessage?: string) {
    this.logger.log('[UPDATE_PRINT_STATUS] 인쇄 상태 업데이트 시작:', {
      printId,
      newStatus: status,
      hasErrorMessage: !!errorMessage
    });
    
    try {
      const itemIndex = this.printQueue.findIndex(item => item.id === printId);
      
      if (itemIndex === -1) {
        this.logger.error('[UPDATE_PRINT_STATUS] 인쇄 작업을 찾을 수 없음:', {
          printId,
          totalItems: this.printQueue.length,
          existingIds: this.printQueue.map(item => item.id)
        });
        throw new Error(`인쇄 작업을 찾을 수 없습니다: ${printId}`);
      }
      
      this.logger.debug('[UPDATE_PRINT_STATUS] 인쇄 작업 찾기 성공:', {
        printId,
        itemIndex,
        currentStatus: this.printQueue[itemIndex].status
      });

      const item = this.printQueue[itemIndex];
      const oldStatus = item.status;
      const oldAttemptCount = item.attemptCount;
      
      item.status = status;
      item.attemptCount += 1;

      this.logger.log('[UPDATE_PRINT_STATUS] 인쇄 상태 업데이트 완료:', {
        printId,
        oldStatus,
        newStatus: status,
        oldAttemptCount,
        newAttemptCount: item.attemptCount,
        errorMessage
      });

      if (status === 'completed') {
        this.logger.log('[UPDATE_PRINT_STATUS] 완료된 인쇄 작업 자동 정리 예약 (30초 후):', printId);
        
        // 완료된 항목은 30초 후 대기열에서 제거
        setTimeout(() => {
          const index = this.printQueue.findIndex(item => item.id === printId);
          if (index !== -1) {
            this.printQueue.splice(index, 1);
            this.logger.log('[UPDATE_PRINT_STATUS] 완료된 인쇄 작업 자동 정리 완료:', {
              printId,
              remainingQueueSize: this.printQueue.length
            });
          }
        }, 30000);
      } else if (status === 'failed') {
        this.logger.warn('[UPDATE_PRINT_STATUS] 인쇄 작업 실패 처리:', {
          printId,
          attemptCount: item.attemptCount,
          errorMessage
        });
        
        // 실패한 경우 3번 시도 후 대기열에서 제거
        if (item.attemptCount >= 3) {
          this.printQueue.splice(itemIndex, 1);
          this.logger.warn('[UPDATE_PRINT_STATUS] 인쇄 작업 최종 실패로 인한 제거:', {
            printId,
            finalAttemptCount: item.attemptCount,
            remainingQueueSize: this.printQueue.length
          });
        } else {
          // 재시도를 위해 pending 상태로 복구
          item.status = 'pending';
          this.logger.log('[UPDATE_PRINT_STATUS] 인쇄 작업 재시도를 위한 pending 상태 복구:', {
            printId,
            attemptCount: item.attemptCount,
            maxAttempts: 3
          });
        }
      }

      const result = {
        status: 'success',
        message: `인쇄 상태가 업데이트되었습니다: ${status}`,
        printId,
        newStatus: item.status,
        attemptCount: item.attemptCount,
      };
      
      this.logger.log('[UPDATE_PRINT_STATUS] 인쇄 상태 업데이트 성공적으로 완료:', result);
      return result;

    } catch (error: any) {
      this.logger.error('[UPDATE_PRINT_STATUS] 인쇄 상태 업데이트 오류:', {
        error: error.message,
        stack: error.stack,
        printId,
        status,
        errorMessage
      });
      throw new BadRequestException(`인쇄 상태 업데이트 실패: ${error.message}`);
    }
  }

  // 인쇄 대기열 통계
  async getPrintQueueStats() {
    this.logger.debug('[GET_PRINT_STATS] 인쇄 대기열 통계 조회 시작');
    
    const stats = {
      total: this.printQueue.length,
      pending: this.printQueue.filter(item => item.status === 'pending').length,
      printing: this.printQueue.filter(item => item.status === 'printing').length,
      completed: this.printQueue.filter(item => item.status === 'completed').length,
      failed: this.printQueue.filter(item => item.status === 'failed').length,
    };

    const lastUpdate = new Date().toISOString();
    
    this.logger.debug('[GET_PRINT_STATS] 대기열 통계 생성 완료:', stats);
    
    const result = {
      status: 'success',
      stats,
      lastUpdate,
    };
    
    this.logger.debug('[GET_PRINT_STATS] 인쇄 대기열 통계 조회 완료');
    return result;
  }

  // 개인키로 지갑 잔고 조회 (ETH + ERC20)
  async getWalletBalanceByPrivateKey(privateKey: string) {
    this.logger.log('[WALLET_BALANCE] 지갑 잔고 조회 시작');
    this.logger.debug('[WALLET_BALANCE] 개인키 검증:', {
      hasPrivateKey: !!privateKey,
      startsWithHex: privateKey?.startsWith('0x'),
      privateKeyPrefix: privateKey?.substring(0, 10) + '...'
    });

    try {
      if (!privateKey) {
        this.logger.error('[WALLET_BALANCE] 개인키가 없습니다');
        throw new Error('개인키가 제공되지 않았습니다.');
      }

      // 개인키에 0x 접두사가 없으면 자동으로 추가
      if (!privateKey.startsWith('0x')) {
        this.logger.debug('[WALLET_BALANCE] 개인키에 0x 접두사 추가');
        privateKey = '0x' + privateKey;
      }

      // 개인키 길이 검증 (0x 포함하여 66자여야 함)
      if (privateKey.length !== 66) {
        this.logger.error('[WALLET_BALANCE] 유효하지 않은 개인키 길이:', {
          length: privateKey.length,
          expected: 66
        });
        throw new Error('유효하지 않은 개인키 길이입니다.');
      }

      this.logger.log('[WALLET_BALANCE] 개인키로 지갑 생성 시작');

      // 개인키로 지갑 생성
      const wallet = new ethers.Wallet(privateKey, this.provider);
      const address = await wallet.getAddress();

      this.logger.log('[WALLET_BALANCE] 지갑 생성 완료:', {
        address,
        hasProvider: !!this.provider
      });

      this.logger.log('[WALLET_BALANCE] ETH 잔액 조회 시작');

      // ETH 잔액 조회
      const ethBal = await this.provider.getBalance(address);
      
      this.logger.debug('[WALLET_BALANCE] ETH 잔액 조회 완료:', {
        address,
        rawBalance: ethBal.toString(),
        formattedBalance: ethers.formatEther(ethBal)
      });

      this.logger.log('[WALLET_BALANCE] ERC20 토큰 정보 조회 시작');

      // ERC20 잔액 조회
      const tokenAddress = process.env.TOKEN!;
      
      if (!tokenAddress) {
        this.logger.warn('[WALLET_BALANCE] TOKEN 환경변수가 설정되지 않음');
        throw new Error('TOKEN 환경변수가 설정되지 않았습니다.');
      }

      this.logger.debug('[WALLET_BALANCE] 토큰 컨트랙트 설정:', {
        tokenAddress,
        rpcUrl: process.env.RPC_URL
      });

      const erc20Abi = [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
        'function name() view returns (string)',
      ] as const;

      const token = new ethers.Contract(tokenAddress, erc20Abi, this.provider);
      
      this.logger.log('[WALLET_BALANCE] 토큰 정보 병렬 조회 시작');
      
      const [rawBal, decimals, symbol, name] = await Promise.all([
        token.balanceOf(address),
        token.decimals(),
        token.symbol(),
        token.name(),
      ]);

      this.logger.debug('[WALLET_BALANCE] 토큰 정보 조회 완료:', {
        symbol,
        name,
        decimals: Number(decimals),
        rawBalance: rawBal.toString(),
        formattedBalance: ethers.formatUnits(rawBal, decimals)
      });

      const timestamp = new Date().toISOString();
      const balanceInfo = {
        address,
        ethBalance: {
          raw: ethBal.toString(),
          formatted: ethers.formatEther(ethBal),
          symbol: 'ETH',
        },
        tokenBalance: {
          raw: rawBal.toString(),
          formatted: ethers.formatUnits(rawBal, decimals),
          symbol: symbol,
          name: name,
          address: tokenAddress,
          decimals: Number(decimals),
        },
        chainId: Number(process.env.CHAIN_ID),
        rpcUrl: process.env.RPC_URL,
        timestamp,
      };

      this.logger.log('[WALLET_BALANCE] 잔고 조회 성공적으로 완료:', {
        address,
        ethBalance: balanceInfo.ethBalance.formatted,
        tokenBalance: `${balanceInfo.tokenBalance.formatted} ${symbol}`,
        chainId: balanceInfo.chainId
      });

      const result = {
        status: 'success',
        balance: balanceInfo,
      };

      this.logger.log('[WALLET_BALANCE] 최종 응답 반환 완료');
      return result;

    } catch (error: any) {
      this.logger.error('[WALLET_BALANCE] 지갑 잔고 조회 실패:', {
        error: error.message,
        stack: error.stack,
        privateKeyPrefix: privateKey?.substring(0, 10) + '...',
        tokenAddress: process.env.TOKEN,
        chainId: process.env.CHAIN_ID,
        rpcUrl: process.env.RPC_URL
      });
      throw new BadRequestException(`지갑 잔고 조회 실패: ${error.message}`);
    }
  }

  // EOA nonce 조회
  async getEOANonce(authority: string): Promise<number> {
    this.logger.debug('[GET_EOA_NONCE] EOA nonce 조회 시작:', authority);
    try {
      const nonce = await this.provider.getTransactionCount(authority, 'latest');
      this.logger.debug('[GET_EOA_NONCE] EOA nonce 조회 성공:', { authority, nonce });
      return nonce;
    } catch (error: any) {
      this.logger.error('[GET_EOA_NONCE] EOA nonce 조회 실패:', error.message);
      throw new BadRequestException(`EOA nonce 조회 실패: ${error.message}`);
    }
  }

  // Transfer 데이터 준비
  async prepareTransferData(body: any) {
    const { authority, token, to, amount } = body;
    
    this.logger.log('[PREPARE_TRANSFER] Transfer 데이터 준비 시작');
    this.logger.debug('[PREPARE_TRANSFER] 요청 데이터:', { authority, token, to, amount });
    
    try {
      // EOA transaction nonce 조회 (EIP-7702는 EOA nonce 사용)
      this.logger.debug('[PREPARE_TRANSFER] EOA transaction nonce 조회 시작');
      const eoaNonce = await this.provider.getTransactionCount(authority, 'latest');
      this.logger.debug('[PREPARE_TRANSFER] EOA transaction nonce 조회 결과:', eoaNonce);
      
      // deadline 설정 (5분 후)
      const deadline = Math.floor(Date.now() / 1000) + 300;
      
      const result = {
        nonce: eoaNonce.toString(),
        deadline: deadline.toString()
      };
      
      this.logger.debug('[PREPARE_TRANSFER] Transfer 데이터 준비 완료:', result);
      return result;
      
    } catch (error: any) {
      this.logger.error('[PREPARE_TRANSFER] Transfer 데이터 준비 실패:', error.message);
      throw new BadRequestException(`Transfer 데이터 준비 실패: ${error.message}`);
    }
  }

  // 서명된 결제 처리
  async processSignedPayment(body: any) {
    const { authority, authorization, transfer, publicKey, productName, product } = body;
    
    this.logger.log('[SIGNED_PAYMENT] 서명된 결제 처리 시작');
    this.logger.debug('[SIGNED_PAYMENT] 받은 데이터:', {
      authority,
      hasAuthorization: !!authorization,
      hasTransfer: !!transfer,
      publicKey: publicKey?.substring(0, 20) + '...',
      productName: productName || product || '상품명 없음',
      hasProductName: !!(productName || product)
    });
    
    this.logger.log(`[PRODUCT_NAME_TRACKING] 상품명 확인: ${productName || product || '상품명 없음'}`);
    
    try {
      // 공개키 형식 검증
      if (!publicKey || typeof publicKey !== 'string' || !publicKey.startsWith('0x')) {
        this.logger.error('[SIGNED_PAYMENT] 공개키 형식 오류:', publicKey);
        throw new BadRequestException('공개키 형식이 올바르지 않습니다');
      }

      // 공개키에서 주소 복구하여 authority 검증
      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.computeAddress(publicKey);
      } catch (keyError: any) {
        this.logger.error('[SIGNED_PAYMENT] 공개키 주소 계산 실패:', keyError.message);
        throw new BadRequestException('공개키에서 주소를 계산할 수 없습니다: ' + keyError.message);
      }

      if (recoveredAddress.toLowerCase() !== authority.toLowerCase()) {
        this.logger.error('[SIGNED_PAYMENT] 공개키 검증 실패:', {
          expected: authority,
          recovered: recoveredAddress
        });
        throw new BadRequestException('공개키와 authority 주소가 일치하지 않습니다');
      }
      
      this.logger.debug('[SIGNED_PAYMENT] 공개키 검증 성공');
      
      // 디버깅 로그 추가
      this.logger.debug('[PAYMENT_DEBUG] Received payment request:', {
        authority,
        transfer: transfer.transfer,
        domain: transfer.domain,
        authorization: authorization,
        signature712: transfer.signature?.substring(0, 20) + '...'
      });

      // 기존 payment 로직 재사용 (이미 서명된 데이터 사용)
      const paymentResult = await this.payment({
        authority,
        transfer: transfer.transfer,
        domain: transfer.domain,
        types: transfer.types,
        signature712: transfer.signature,
        authorization: authorization
      });
      
      // 상품명 정보를 응답에 추가
      if (productName || product) {
        this.logger.log(`[PRODUCT_NAME_TRACKING] 응답에 상품명 추가: ${productName || product}`);
        return {
          ...paymentResult,
          productName: productName || product
        };
      }
      
      return paymentResult;
      
    } catch (error: any) {
      this.logger.error('[SIGNED_PAYMENT] 서명된 결제 처리 실패:', error.message);
      throw error;
    }
  }
}

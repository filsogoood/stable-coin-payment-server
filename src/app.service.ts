// app.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { 
  createWalletClient, 
  createPublicClient, 
  http, 
  parseAbi, 
  encodeAbiParameters,
  decodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  getContract,
  type Hex,
  type Address,
  type WalletClient,
  type PublicClient,
  type Chain,
  verifyTypedData,
  parseSignature,
  type AuthorizationRequest,
  keccak256,
  toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import * as QRCode from 'qrcode';

// Helper functions
const formatAddr = (addr: string) => addr as Address;
const formatHex = (hex: string) => hex as Hex;

@Injectable()
export class AppService {
  private readonly logger = new Logger('AppService');

  private chain: Chain;
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private relayerAccount: any;

  constructor() {
    // Chain 설정 (Sepolia 사용)
    this.chain = sepolia;
    
    // Public Client 생성 (읽기 전용)
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(process.env.RPC_URL),
    });

    // Relayer Account 생성
    this.relayerAccount = privateKeyToAccount(formatHex(process.env.SPONSOR_PK!));

    // Wallet Client 생성 (트랜잭션 전송용)
    this.walletClient = createWalletClient({
      account: this.relayerAccount,
      chain: this.chain,
      transport: http(process.env.RPC_URL),
    });
  }

  private readonly DELEGATE_ABI = parseAbi([
    'function executeSignedTransfer((address from,address token,address to,uint256 amount,uint256 nonce,uint256 deadline) t, bytes sig) external',
    'function nonce() view returns (uint256)',
  ]);

  private readonly ERC20_ABI = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);

  private readonly ERROR_SIGNATURES = {
    BadContext: '0xa73e45fb',
    Expired: '0x7957aac2',
    BadSignature: '0x8baa579f',
    BadNonce: '0x5428f825',
    ERC20InsufficientBalance: '0xe450d38c',
    ERC20InsufficientAllowance: '0xfb8f41b2',
    SafeERC20FailedOperation: '0x5274afe7',
  };

  private isAddr(a?: string): boolean { 
    return !!a && /^0x[0-9a-fA-F]{40}$/.test(a); 
  }
  
  private eqAddr(a?: string, b?: string): boolean { 
    return !!a && !!b && a.toLowerCase() === b.toLowerCase(); 
  }
  
  private short(h?: string, n=6): string { 
    return (!h||!h.startsWith('0x'))?String(h):(`${h.slice(0,2+n)}…${h.slice(-n)}`); 
  }

  // nextNonce 읽기: ① authorization 있으면 nonce() 뷰 호출 시도 → 실패 시 ② slot0
  private async readNextNonce(
    authority: Address, 
    authorization?: AuthorizationRequest
  ): Promise<bigint> {
    // ① nonce() 뷰 시도 (type:4 + authorizationList 필요)
    if (authorization) {
      try {
        const data = encodeFunctionData({
          abi: this.DELEGATE_ABI,
          functionName: 'nonce',
          args: [],
        });

        this.logger.debug(`[nextNonce:view] 시도 중... auth=${this.short(authorization.signature)}`);
        
        // Viem: call with authorizationList
        const result = await this.publicClient.request({
          method: 'eth_call' as any,
          params: [
            {
              to: authority,
              data,
              type: '0x4',
              authorizationList: [authorization],
            },
            'latest'
          ],
        } as any);

        const decoded = decodeFunctionResult({
          abi: this.DELEGATE_ABI,
          functionName: 'nonce',
          data: result as Hex,
        });

        const nonce = decoded as bigint;
        this.logger.debug(`[nextNonce:view] 성공: ${nonce.toString()}`);
        return nonce;

      } catch (e: any) {
        this.logger.warn(`[nextNonce:view] 실패, slot0으로 폴백: ${e?.message}`);
        // 폴백으로 진행
      }
    }

    // ② slot0 직접 조회 (EIP-7702 컨텍스트 없어도 항상 동작)
    try {
      const raw = await this.publicClient.getStorageAt({
        address: authority,
        slot: '0x0',
      });
      const nonce = BigInt(raw || 0);
      this.logger.debug(`[nextNonce:slot0] ${nonce.toString()}`);
      return nonce;
    } catch (storageError: any) {
      this.logger.error(`[nextNonce:slot0] 실패: ${storageError?.message}`);
      return 0n;
    }
  }

  // 클라이언트가 미리 nextNonce만 요청
  async getNextNonce(authority: string, authorization?: any) {
    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    
    let authRequest: AuthorizationRequest | undefined;
    if (authorization?.signature) {
      authRequest = {
        chainId: authorization.chainId,
        address: formatAddr(authorization.address),
        nonce: authorization.nonce,
        signature: formatHex(authorization.signature),
      } as AuthorizationRequest;
    }
    
    const next = await this.readNextNonce(formatAddr(authority), authRequest);
    return { 
      authority, 
      nextNonce: next.toString(), 
      via: authorization?.signature ? 'view-or-slot' : 'slot' 
    };
  }

  // 메인 결제 처리
  async payment(body: any) {
    const { authority, transfer, domain, types, signature712, authorization } = body ?? {};
    this.logger.debug(`[ADDRESS_DEBUG] authority=${authority}`);

    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    if (!transfer) throw new BadRequestException('transfer missing');
    if (!this.isAddr(transfer.from) || !this.isAddr(transfer.token) || !this.isAddr(transfer.to)) {
      throw new BadRequestException('transfer address invalid');
    }

    // 체인 ID 확인
    const chainId = await this.publicClient.getChainId();
    if (Number(chainId) !== Number(domain?.chainId)) {
      throw new BadRequestException('chainId mismatch');
    }
    if (!this.eqAddr(domain?.verifyingContract, process.env.DELEGATE_ADDRESS)) {
      throw new BadRequestException('verifyingContract must equal DELEGATE_ADDRESS');
    }
    if (!this.eqAddr(transfer.from, authority)) {
      throw new BadRequestException('transfer.from must equal authority');
    }

    // EIP-712 서명 검증 (Viem 버전)
    const isValid = await verifyTypedData({
      address: formatAddr(authority),
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: formatAddr(domain.verifyingContract),
      },
      types,
      primaryType: 'Transfer',
      message: {
        from: formatAddr(transfer.from),
        token: formatAddr(transfer.token),
        to: formatAddr(transfer.to),
        amount: BigInt(String(transfer.amount)),
        nonce: BigInt(String(transfer.nonce)),
        deadline: BigInt(String(transfer.deadline ?? 0)),
      },
      signature: formatHex(signature712),
    });

    if (!isValid) {
      throw new BadRequestException({ 
        code: 'BAD_712_SIGNER',
        message: 'Invalid signature',
      });
    }

    // Authorization 준비
    let authRequest: AuthorizationRequest | undefined;
    if (authorization?.signature) {
      authRequest = {
        chainId: authorization.chainId,
        address: formatAddr(authorization.address),
        nonce: authorization.nonce,
        signature: formatHex(authorization.signature),
      } as AuthorizationRequest;
    }

    // NextNonce 읽기
    const onchainNext = await this.readNextNonce(formatAddr(authority), authRequest);
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
    const erc20 = getContract({
      address: formatAddr(transfer.token),
      abi: this.ERC20_ABI,
      client: this.publicClient,
    });

    let balance: bigint;
    try {
      balance = await erc20.read.balanceOf([formatAddr(authority)]) as bigint;
    } catch {
      balance = 0n;
    }

    const needed = BigInt(String(transfer.amount));
    if (balance < needed) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        balance: balance.toString(),
        needed: needed.toString(),
      });
    }

    // Calldata 준비
    const calldata = encodeFunctionData({
      abi: this.DELEGATE_ABI,
      functionName: 'executeSignedTransfer',
      args: [
        {
          from: formatAddr(transfer.from),
          token: formatAddr(transfer.token),
          to: formatAddr(transfer.to),
          amount: needed,
          nonce: tNonce,
          deadline: BigInt(String(transfer.deadline ?? 0)),
        },
        formatHex(signature712),
      ],
    });

    this.logger.debug(`[calldata] len=${(calldata.length-2)/2}B hash=${this.short(keccak256(calldata))}`);

    // EIP-7702 authorization 필수 체크
    if (!authorization?.signature) {
      throw new BadRequestException({
        code: 'AUTHORIZATION_REQUIRED',
        message: 'EIP-7702 authorization이 필요합니다. MetaMask SDK를 사용해주세요.',
        details: {
          requirement: 'MetaMask SDK + Viem',
          networkSupport: 'EIP-7702 지원 네트워크 연결 필요',
        }
      });
    }

    // AuthorizationList 준비
    const authList: AuthorizationRequest[] = [{
      chainId: authorization.chainId,
      address: formatAddr(authorization.address),
      nonce: authorization.nonce,
      signature: formatHex(authorization.signature),
    } as AuthorizationRequest];

    // Simulate
    try {
      await this.publicClient.request({
        method: 'eth_call' as any,
        params: [
          {
            to: authority,
            data: calldata,
            type: '0x4',
            authorizationList: authList,
          },
          'latest'
        ],
      } as any);
      this.logger.log('[simulate] OK');
    } catch (e: any) {
      this.logger.error('[simulate] 실패:', e?.message);
      throw e;
    }

    // Transaction 전송
    try {
      // Viem: sendTransaction with authorizationList
      const hash = await this.walletClient.sendTransaction({
        to: formatAddr(authority),
        data: calldata,
        type: 'eip7702',
        authorizationList: authList,
      } as any);

      this.logger.log(`[sent] txHash=${hash}`);

      // Wait for transaction
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
      });

      this.logger.log(`[mined] status=${receipt.status} gasUsed=${receipt.gasUsed.toString()}`);

      return { 
        status: 'ok', 
        txHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };

    } catch (sendError: any) {
      this.logger.error('[send] 트랜잭션 전송 실패:', sendError?.message);
      throw new BadRequestException({
        code: 'TRANSACTION_FAILED',
        message: sendError?.message || 'Transaction failed',
      });
    }
  }

  // QR 코드 생성 API
  async createPaymentQR(body: any) {
    const { token, to, amount, deadline } = body;
    
    if (!this.isAddr(token)) throw new BadRequestException('token address invalid');
    if (!this.isAddr(to)) throw new BadRequestException('to address invalid');
    if (!amount || amount <= 0) throw new BadRequestException('amount must be positive');

    // 기본값 설정
    const deadlineTs = deadline || Math.floor(Date.now() / 1000) + 3600; // 1시간 후
    const chainId = Number(process.env.CHAIN_ID || 11155111);
    const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:4123';

    // QR 코드에 포함될 데이터
    const qrData = {
      type: 'eip712-payment',
      chainId,
      token,
      to,
      amount: amount.toString(),
      deadline: deadlineTs,
      serverUrl: `${serverUrl}/payment`,
      delegateAddress: process.env.DELEGATE_ADDRESS,
    };

    try {
      const qrCodeDataURL = await QRCode.toDataURL(JSON.stringify(qrData), {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 512
      });

      return {
        status: 'success',
        qrCode: qrCodeDataURL,
        qrData,
        paymentPageUrl: `${serverUrl}/payment-page?token=${token}&to=${to}&amount=${amount}&deadline=${deadlineTs}`
      };
    } catch (error) {
      this.logger.error('QR 코드 생성 실패:', error);
      throw new BadRequestException('QR 코드 생성 중 오류가 발생했습니다');
    }
  }

  // 웹 인터페이스 HTML 생성 - MetaMask SDK와 Viem 사용
  async getPaymentPageHTML(query: any) {
    const { token, to, amount, deadline } = query;
    
    if (!this.isAddr(token)) throw new BadRequestException('token address invalid');
    if (!this.isAddr(to)) throw new BadRequestException('to address invalid');
    if (!amount || amount <= 0) throw new BadRequestException('amount must be positive');

    const chainId = Number(process.env.CHAIN_ID || 11155111);
    const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:4123';
    const deadlineTs = deadline || Math.floor(Date.now() / 1000) + 3600;

    // QR 코드 데이터
    const qrData = {
      type: 'eip712-payment',
      chainId,
      token,
      to,
      amount: amount.toString(),
      deadline: deadlineTs,
      serverUrl: `${serverUrl}/payment`,
      delegateAddress: process.env.DELEGATE_ADDRESS,
    };

    const qrCodeDataURL = await QRCode.toDataURL(JSON.stringify(qrData), {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 512
    });

    // MetaMask SDK를 사용하는 HTML
    const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>암호화폐 결제 - MetaMask SDK</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            max-width: 500px;
            width: 100%;
        }
        .title {
            color: #333;
            margin-bottom: 30px;
            font-size: 24px;
            font-weight: 600;
        }
        .qr-container {
            margin: 30px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 15px;
        }
        .qr-code {
            max-width: 100%;
            border-radius: 10px;
        }
        .payment-info {
            background: #f1f3f4;
            border-radius: 12px;
            padding: 20px;
            margin: 20px 0;
            text-align: left;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
            font-size: 14px;
        }
        .info-label {
            font-weight: 600;
            color: #555;
        }
        .info-value {
            color: #333;
            font-family: 'Courier New', monospace;
            word-break: break-all;
        }
        .instruction {
            color: #666;
            font-size: 16px;
            margin: 20px 0;
            line-height: 1.5;
        }
        .metamask-btn {
            background: linear-gradient(45deg, #f6851b, #e2761b);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin: 10px;
            transition: transform 0.2s;
        }
        .metamask-btn:hover {
            transform: scale(1.05);
        }
        .metamask-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
        }
        .status {
            margin: 20px 0;
            padding: 10px;
            border-radius: 8px;
            font-weight: 600;
        }
        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        .status.info {
            background: #d1ecf1;
            color: #0c5460;
            border: 1px solid #bee5eb;
        }
        .warning {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
            padding: 10px;
            border-radius: 8px;
            margin: 10px 0;
            font-size: 14px;
        }
        .connection-status {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            margin: 10px 0;
        }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #dc3545;
        }
        .status-dot.connected {
            background: #28a745;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="title">💰 MetaMask SDK 결제</h1>
        
        <div class="connection-status">
            <div id="statusDot" class="status-dot"></div>
            <span id="connectionText">MetaMask 연결 대기 중...</span>
        </div>
        
        <div class="payment-info">
            <div class="info-row">
                <span class="info-label">토큰:</span>
                <span class="info-value">${token}</span>
            </div>
            <div class="info-row">
                <span class="info-label">받는 주소:</span>
                <span class="info-value">${to}</span>
            </div>
            <div class="info-row">
                <span class="info-label">금액:</span>
                <span class="info-value">${amount} wei</span>
            </div>
            <div class="info-row">
                <span class="info-label">마감시간:</span>
                <span class="info-value">${new Date(deadlineTs * 1000).toLocaleString('ko-KR')}</span>
            </div>
        </div>

        <div class="instruction">
            📱 MetaMask SDK로 안전하게 결제하세요
            <br><small>모바일 지갑 연결 지원</small>
        </div>

        <div class="qr-container">
            <img src="${qrCodeDataURL}" alt="Payment QR Code" class="qr-code" />
        </div>

        <button id="connectBtn" class="metamask-btn" onclick="connectMetaMask()">
            🦊 MetaMask 연결
        </button>
        
        <button id="signBtn" class="metamask-btn" onclick="signWithMetaMaskSDK()" style="display: none;">
            ✍️ 서명하고 결제하기
        </button>

        <div id="status"></div>
    </div>

    <!-- MetaMask SDK와 Viem을 모듈로 로드 -->
    <script type="module">
        import { MetaMaskSDK } from 'https://esm.sh/@metamask/sdk@0.31.2';
        import { 
            createWalletClient, 
            createPublicClient,
            custom,
            http,
            encodeFunctionData,
            decodeFunctionResult,
            parseAbi
        } from 'https://esm.sh/viem@2.21.0';
        import { sepolia } from 'https://esm.sh/viem@2.21.0/chains';

        const qrData = ${JSON.stringify(qrData)};
        
        // MetaMask SDK 초기화
        const MMSDK = new MetaMaskSDK({
            dappMetadata: {
                name: "Stable Coin Payment",
                url: window.location.origin,
            },
            logging: {
                developerMode: true,
            },
            checkInstallationImmediately: false,
            i18nOptions: {
                enabled: true
            },
            // 모바일 딥링킹 설정
            useDeeplink: true,
            // QR 코드 모달 설정
            openDeeplink: (link) => {
                window.open(link, '_blank');
            },
        });

        const ethereum = MMSDK.getProvider();
        
        let walletClient = null;
        let publicClient = null;
        let connectedAccount = null;

        // Public Client 생성
        publicClient = createPublicClient({
            chain: sepolia,
            transport: http()
        });

        // 전역 함수로 등록
        window.connectMetaMask = async function() {
            const statusDiv = document.getElementById('status');
            const connectBtn = document.getElementById('connectBtn');
            const signBtn = document.getElementById('signBtn');
            const statusDot = document.getElementById('statusDot');
            const connectionText = document.getElementById('connectionText');
            
            try {
                statusDiv.innerHTML = '<div class="status info">MetaMask SDK로 연결 중...</div>';
                connectBtn.disabled = true;

                // MetaMask SDK로 연결
                const accounts = await ethereum.request({ 
                    method: 'eth_requestAccounts',
                    params: []
                });
                
                if (!accounts || accounts.length === 0) {
                    throw new Error('계정을 가져올 수 없습니다');
                }

                connectedAccount = accounts[0];
                console.log('✅ MetaMask SDK 연결 성공:', connectedAccount);
                
                // Wallet Client 생성
                walletClient = createWalletClient({
                    chain: sepolia,
                    transport: custom(ethereum)
                });

                // UI 업데이트
                statusDot.classList.add('connected');
                connectionText.textContent = \`연결됨: \${connectedAccount.substring(0, 6)}...\${connectedAccount.substring(38)}\`;
                
                statusDiv.innerHTML = '<div class="status success">✅ MetaMask 연결 완료!</div>';
                connectBtn.style.display = 'none';
                signBtn.style.display = 'inline-block';
                
            } catch (error) {
                console.error('❌ MetaMask 연결 실패:', error);
                statusDiv.innerHTML = \`<div class="status error">❌ 연결 실패: \${error.message}</div>\`;
                connectBtn.disabled = false;
            }
        }

        window.signWithMetaMaskSDK = async function() {
            const statusDiv = document.getElementById('status');
            const signBtn = document.getElementById('signBtn');
            
            if (!connectedAccount || !walletClient) {
                statusDiv.innerHTML = '<div class="status error">먼저 MetaMask를 연결해주세요</div>';
                return;
            }
            
            try {
                statusDiv.innerHTML = '<div class="status info">결제 준비 중...</div>';
                signBtn.disabled = true;

                // 1. Nonce 조회
                statusDiv.innerHTML = '<div class="status info">nonce 조회 중...</div>';
                const nonceResponse = await fetch('/get-nonce', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ authority: connectedAccount })
                });
                const nonceData = await nonceResponse.json();
                const nextNonce = nonceData.nextNonce;

                // 2. EIP-712 도메인 및 타입 정의
                const domain = {
                    name: 'DelegatedTransfer',
                    version: '1',
                    chainId: qrData.chainId,
                    verifyingContract: qrData.delegateAddress
                };

                const types = {
                    Transfer: [
                        { name: 'from', type: 'address' },
                        { name: 'token', type: 'address' },
                        { name: 'to', type: 'address' },
                        { name: 'amount', type: 'uint256' },
                        { name: 'nonce', type: 'uint256' },
                        { name: 'deadline', type: 'uint256' }
                    ]
                };

                const transfer = {
                    from: connectedAccount,
                    token: qrData.token,
                    to: qrData.to,
                    amount: qrData.amount,
                    nonce: nextNonce,
                    deadline: qrData.deadline
                };

                // 3. EIP-7702 Authorization 생성
                statusDiv.innerHTML = '<div class="status info">EIP-7702 authorization 생성 중...</div>';
                
                let authItem = null;
                try {
                    // EOA nonce 조회
                    const eoaNonce = await publicClient.getTransactionCount({ 
                        address: connectedAccount,
                        blockTag: 'latest'
                    });
                    
                    console.log('🔍 Authorization 요청:', {
                        contractAddress: qrData.delegateAddress,
                        chainId: qrData.chainId,
                        nonce: eoaNonce
                    });

                    // MetaMask SDK를 통한 signAuthorization
                    // Viem의 실험적 기능 사용
                    const authRequest = {
                        contractAddress: qrData.delegateAddress,
                        chainId: qrData.chainId,
                        nonce: eoaNonce
                    };

                    // walletClient.signAuthorization 시도
                    if (walletClient.signAuthorization) {
                        const authorization = await walletClient.signAuthorization(authRequest);
                        authItem = {
                            chainId: authorization.chainId,
                            address: authorization.contractAddress,
                            nonce: authorization.nonce,
                            signature: authorization.signature
                        };
                        console.log('✅ EIP-7702 authorization 성공:', authItem);
                    } else {
                        // Fallback: eth_signAuthorization RPC 직접 호출
                        const authorization = await ethereum.request({
                            method: 'eth_signAuthorization',
                            params: [authRequest]
                        });
                        
                        authItem = authorization;
                        console.log('✅ EIP-7702 authorization 성공 (RPC):', authItem);
                    }
                    
                } catch (authError) {
                    console.error('❌ EIP-7702 authorization 실패:', authError);
                    
                    // 더 자세한 에러 메시지
                    let errorMessage = 'EIP-7702 authorization 실패\\n\\n';
                    if (authError.message?.includes('not supported') || authError.message?.includes('does not exist')) {
                        errorMessage += '현재 MetaMask 버전이 EIP-7702를 지원하지 않습니다.\\n';
                        errorMessage += 'MetaMask를 최신 버전으로 업데이트하거나\\n';
                        errorMessage += 'EIP-7702가 활성화된 네트워크를 사용해주세요.';
                    } else {
                        errorMessage += authError.message || '알 수 없는 오류';
                    }
                    
                    statusDiv.innerHTML = \`
                        <div class="status error">
                            ⚠️ \${errorMessage}
                        </div>
                    \`;
                    throw new Error(errorMessage);
                }

                // 4. EIP-712 서명
                statusDiv.innerHTML = '<div class="status info">거래 서명 요청 중...</div>';
                
                const signature712 = await ethereum.request({
                    method: 'eth_signTypedData_v4',
                    params: [
                        connectedAccount,
                        JSON.stringify({
                            domain,
                            types,
                            primaryType: 'Transfer',
                            message: transfer
                        })
                    ]
                });

                // 5. 서버로 전송
                statusDiv.innerHTML = '<div class="status info">서버로 전송 중...</div>';
                
                const response = await fetch(qrData.serverUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        authority: connectedAccount,
                        transfer,
                        domain,
                        types,
                        signature712,
                        authorization: authItem
                    })
                });

                const result = await response.json();
                
                if (response.ok) {
                    statusDiv.innerHTML = \`
                        <div class="status success">
                            ✅ 결제 완료!<br>
                            트랜잭션: <a href="https://sepolia.etherscan.io/tx/\${result.txHash}" target="_blank">\${result.txHash.substring(0, 10)}...</a>
                        </div>
                    \`;
                } else {
                    console.error('서버 응답 오류:', result);
                    throw new Error(result.message || result.error || '서버 오류');
                }

            } catch (error) {
                console.error('Error:', error);
                statusDiv.innerHTML = \`<div class="status error">❌ 오류: \${error.message}</div>\`;
            } finally {
                signBtn.disabled = false;
            }
        }

        // 페이지 로드 시 자동 연결 시도
        window.addEventListener('load', async () => {
            // 이미 연결된 계정이 있는지 확인
            try {
                const accounts = await ethereum.request({ method: 'eth_accounts' });
                if (accounts && accounts.length > 0) {
                    // 자동으로 연결
                    await window.connectMetaMask();
                }
            } catch (error) {
                console.log('자동 연결 실패:', error);
            }
        });

        // 계정 변경 감지
        if (ethereum) {
            ethereum.on('accountsChanged', (accounts) => {
                if (accounts.length === 0) {
                    // 연결 해제
                    location.reload();
                } else {
                    // 계정 변경
                    connectedAccount = accounts[0];
                    document.getElementById('connectionText').textContent = 
                        \`연결됨: \${connectedAccount.substring(0, 6)}...\${connectedAccount.substring(38)}\`;
                }
            });

            ethereum.on('chainChanged', () => {
                // 체인 변경 시 페이지 새로고침
                location.reload();
            });
        }
    </script>
</body>
</html>`;

    return html;
  }
}

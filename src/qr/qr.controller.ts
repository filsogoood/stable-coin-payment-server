import { Controller, Post, Body, Get, Query, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { QrService } from './qr.service';
import type { PaymentRequest } from './qr.service';

@Controller('qr')
export class QrController {
  constructor(private readonly qrService: QrService) {}

  /**
   * QR 코드 스캔 후 자동 결제 실행 페이지
   * QR 코드에 포함된 URL로 리다이렉트되면 자동으로 결제를 실행합니다
   */
  @Get('execute')
  @Header('Content-Type', 'text/html')
  async executePayment(
    @Res({ passthrough: false }) res: Response,
    @Query('to') to?: string,
    @Query('amount') amount?: string,
    @Query('token') token?: string,
    @Query('chainId') chainId?: string,
    @Query('memo') memo?: string,
  ) {
    try {
      const paymentInfo = {
        to: to || process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8',
        amount: amount || '0.001',
        token: token || process.env.TOKEN || 'ETH',
        chainId: chainId ? parseInt(chainId) : (process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111),
        memo: memo || 'QR Payment',
      };

      const html = `
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>결제 진행 중</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              padding: 20px;
            }
            
            .container {
              background: white;
              border-radius: 20px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              padding: 40px;
              max-width: 500px;
              width: 100%;
            }
            
            h1 {
              color: #333;
              text-align: center;
              margin-bottom: 30px;
              font-size: 28px;
            }
            
            .status {
              text-align: center;
              padding: 20px;
              margin-bottom: 30px;
            }
            
            .loading {
              display: inline-block;
              width: 50px;
              height: 50px;
              border: 3px solid rgba(0,0,0,.3);
              border-radius: 50%;
              border-top-color: #667eea;
              animation: spin 1s ease-in-out infinite;
            }
            
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
            
            .status-text {
              color: #666;
              font-size: 18px;
              margin-top: 20px;
            }
            
            .payment-info {
              background: #f1f3f5;
              border-radius: 10px;
              padding: 20px;
              margin-bottom: 20px;
            }
            
            .info-item {
              display: flex;
              justify-content: space-between;
              margin-bottom: 15px;
              font-size: 14px;
            }
            
            .info-label {
              color: #868e96;
              font-weight: 600;
            }
            
            .info-value {
              color: #212529;
              word-break: break-all;
              text-align: right;
              max-width: 60%;
              font-family: 'Courier New', monospace;
              font-size: 12px;
            }
            
            .success {
              background: #d4edda;
              border: 1px solid #c3e6cb;
              color: #155724;
              padding: 20px;
              border-radius: 10px;
              text-align: center;
              display: none;
            }
            
            .success-icon {
              font-size: 48px;
              margin-bottom: 10px;
            }
            
            .error {
              background: #f8d7da;
              border: 1px solid #f5c6cb;
              color: #721c24;
              padding: 20px;
              border-radius: 10px;
              text-align: center;
              display: none;
            }
            
            .error-icon {
              font-size: 48px;
              margin-bottom: 10px;
            }
            
            .tx-hash {
              margin-top: 15px;
              font-size: 12px;
              word-break: break-all;
            }
            
            .gas-sponsor-badge {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 10px;
              border-radius: 8px;
              margin-top: 15px;
              font-size: 14px;
              text-align: center;
            }
            
            .btn {
              display: inline-block;
              padding: 12px 30px;
              border-radius: 10px;
              font-size: 16px;
              cursor: pointer;
              text-decoration: none;
              margin-top: 20px;
              transition: all 0.3s;
            }
            
            .btn-primary {
              background: #667eea;
              color: white;
              border: none;
            }
            
            .btn-primary:hover {
              background: #764ba2;
            }
            
            .manual-section {
              margin-top: 30px;
              padding: 20px;
              background: #f8f9fa;
              border-radius: 10px;
              display: none;
            }
            
            .manual-section h3 {
              color: #495057;
              margin-bottom: 15px;
              font-size: 16px;
            }
            
            .manual-section input {
              width: 100%;
              padding: 10px;
              margin-bottom: 10px;
              border: 1px solid #ced4da;
              border-radius: 5px;
              font-size: 14px;
            }
            
            .manual-section button {
              width: 100%;
              padding: 12px;
              background: #28a745;
              color: white;
              border: none;
              border-radius: 5px;
              cursor: pointer;
              font-size: 16px;
            }
            
            .manual-section button:hover {
              background: #218838;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🚀 결제 진행</h1>
            
            <div class="payment-info">
              <div class="info-item">
                <span class="info-label">받는 주소:</span>
                <span class="info-value">${paymentInfo.to}</span>
              </div>
              <div class="info-item">
                <span class="info-label">금액:</span>
                <span class="info-value">${paymentInfo.amount} ${paymentInfo.token === 'ETH' ? 'ETH' : 'Tokens'}</span>
              </div>
              <div class="info-item">
                <span class="info-label">네트워크:</span>
                <span class="info-value">Sepolia (Chain ID: ${paymentInfo.chainId})</span>
              </div>
              <div class="info-item">
                <span class="info-label">메모:</span>
                <span class="info-value">${paymentInfo.memo}</span>
              </div>
            </div>
            
            <div class="status" id="statusSection">
              <div class="loading"></div>
              <div class="status-text">결제 준비 중...</div>
            </div>
            
            <div class="success" id="successSection">
              <div class="success-icon">✅</div>
              <h2>결제 성공!</h2>
              <p>트랜잭션이 성공적으로 전송되었습니다.</p>
              <div class="tx-hash" id="txHash"></div>
              <div class="gas-sponsor-badge">
                ⛽ 가스비가 받는 쪽에서 대납되었습니다
              </div>
            </div>
            
            <div class="error" id="errorSection">
              <div class="error-icon">❌</div>
              <h2>결제 실패</h2>
              <p id="errorMessage"></p>
            </div>
            
            <div class="manual-section" id="manualSection">
              <h3>수동 결제 정보 입력</h3>
              <input type="text" id="privateKey" placeholder="개인키 입력 (0x로 시작)" />
              <input type="text" id="delegateAddress" placeholder="Delegate 주소 (선택사항)" />
              <button onclick="executeManualPayment()">결제 실행</button>
            </div>
          </div>
          
          <script>
            const paymentInfo = ${JSON.stringify(paymentInfo)};
            const serverUrl = window.location.origin;
            
            // 자동 결제 실행 시도
            async function autoExecutePayment() {
              const statusText = document.querySelector('.status-text');
              
              try {
                // 환경변수에서 설정된 정보로 시도 (서버 사이드)
                statusText.textContent = '환경 설정 확인 중...';
                
                // 클라이언트 사이드에서는 수동 입력 필요
                setTimeout(() => {
                  statusText.textContent = '결제 정보 입력이 필요합니다';
                  document.getElementById('manualSection').style.display = 'block';
                  document.getElementById('statusSection').style.display = 'none';
                }, 2000);
                
              } catch (error) {
                console.error('자동 결제 오류:', error);
                showError(error.message);
              }
            }
            
            // 수동 결제 실행
            async function executeManualPayment() {
              const privateKey = document.getElementById('privateKey').value;
              const delegateAddress = document.getElementById('delegateAddress').value || '0x8B396D123560ac88aCBCf2d4e1d411C956cde5C5';
              
              if (!privateKey || !privateKey.startsWith('0x')) {
                alert('올바른 개인키를 입력해주세요 (0x로 시작)');
                return;
              }
              
              document.getElementById('manualSection').style.display = 'none';
              document.getElementById('statusSection').style.display = 'block';
              document.querySelector('.status-text').textContent = '서명 생성 중...';
              
              try {
                // ethers.js를 사용한 서명 생성 (CDN 로드 필요)
                await loadEthersLibrary();
                
                const provider = new ethers.JsonRpcProvider('https://sepolia.infura.io/v3/YOUR_INFURA_KEY');
                const wallet = new ethers.Wallet(privateKey, provider);
                const authority = wallet.address;
                
                // 1. Authorization 생성
                const eoaNonce = await provider.getTransactionCount(authority, 'latest');
                const auth = await wallet.signAuthorization({
                  address: delegateAddress,
                  nonce: eoaNonce,
                  chainId: paymentInfo.chainId,
                });
                
                // 2. nextNonce 읽기
                document.querySelector('.status-text').textContent = 'Nonce 확인 중...';
                const nextNonce = await getNextNonce(authority, auth);
                
                // 3. EIP-712 서명 생성
                document.querySelector('.status-text').textContent = 'EIP-712 서명 생성 중...';
                const domain = {
                  name: 'DelegatedTransfer',
                  version: '1',
                  chainId: paymentInfo.chainId,
                  verifyingContract: authority,
                };
                
                const types = {
                  Transfer: [
                    { name: 'from', type: 'address' },
                    { name: 'token', type: 'address' },
                    { name: 'to', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                  ],
                };
                
                const transfer = {
                  from: authority,
                  token: paymentInfo.token === 'ETH' ? '0x0000000000000000000000000000000000000000' : paymentInfo.token,
                  to: paymentInfo.to,
                  amount: ethers.parseEther(paymentInfo.amount),
                  nonce: nextNonce,
                  deadline: Math.floor(Date.now() / 1000) + 300,
                };
                
                const signature712 = await wallet.signTypedData(domain, types, transfer);
                
                // 4. 서버로 전송
                document.querySelector('.status-text').textContent = '트랜잭션 전송 중...';
                const response = await fetch(\`\${serverUrl}/payment\`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    authority,
                    transfer: {
                      ...transfer,
                      amount: transfer.amount.toString(),
                      nonce: transfer.nonce.toString(),
                      deadline: transfer.deadline.toString(),
                    },
                    domain,
                    types,
                    signature712,
                    authorization: {
                      chainId: auth.chainId,
                      address: auth.address,
                      nonce: auth.nonce,
                      signature: auth.signature,
                    },
                  }),
                });
                
                const result = await response.json();
                
                if (result.status === 'ok') {
                  showSuccess(result);
                } else {
                  throw new Error(result.error || '결제 실패');
                }
                
              } catch (error) {
                console.error('결제 오류:', error);
                showError(error.message);
              }
            }
            
            // Nonce 조회
            async function getNextNonce(authority, auth) {
              // 간단히 0으로 시작 (실제로는 서버에서 조회해야 함)
              return 0n;
            }
            
            // ethers.js 라이브러리 로드
            async function loadEthersLibrary() {
              return new Promise((resolve, reject) => {
                if (typeof ethers !== 'undefined') {
                  resolve();
                  return;
                }
                
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.umd.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
              });
            }
            
            function showSuccess(result) {
              document.getElementById('statusSection').style.display = 'none';
              document.getElementById('successSection').style.display = 'block';
              document.getElementById('txHash').innerHTML = \`
                <strong>트랜잭션 해시:</strong><br>
                <a href="https://sepolia.etherscan.io/tx/\${result.txHash}" target="_blank">\${result.txHash}</a><br><br>
                <strong>가스비 대납자:</strong> \${result.gasSponsor}
              \`;
            }
            
            function showError(message) {
              document.getElementById('statusSection').style.display = 'none';
              document.getElementById('errorSection').style.display = 'block';
              document.getElementById('errorMessage').textContent = message;
            }
            
            // 페이지 로드 시 자동 실행 시도
            window.addEventListener('DOMContentLoaded', autoExecutePayment);
          </script>
        </body>
        </html>
      `;
      
      res.send(html);
    } catch (error) {
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>오류</title></head>
        <body>
          <div style="text-align: center; margin-top: 50px;">
            <h1>결제 실행 오류</h1>
            <p>${error.message}</p>
          </div>
        </body>
        </html>
      `;
      res.status(500).send(errorHtml);
    }
  }

  /**
   * 자동 실행 결제 QR 코드 생성 API
   * 이 QR 코드를 스캔하면 자동으로 결제가 실행됩니다
   */
  @Get('auto-payment')
  async generateAutoPaymentQR(
    @Query('to') to?: string,
    @Query('amount') amount?: string,
    @Query('token') token?: string,
    @Query('memo') memo?: string,
  ) {
    try {
      const paymentRequest: PaymentRequest = {
        to: to || process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8',
        amount: amount || '0.001',
        token: token || process.env.TOKEN || 'ETH',
        memo: memo || 'Auto Payment',
        chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111,
        autoExecute: true, // 자동 실행 활성화
      };

      const qrCode = await this.qrService.generatePaymentQR(paymentRequest);
      return {
        success: true,
        qrCode,
        data: paymentRequest,
        chainId: paymentRequest.chainId,
        network: 'Sepolia Testnet',
        autoExecute: true,
        executionUrl: `${process.env.SERVER_URL || 'http://localhost:4123'}/qr/execute?to=${paymentRequest.to}&amount=${paymentRequest.amount}&token=${paymentRequest.token}&chainId=${paymentRequest.chainId}&memo=${encodeURIComponent(paymentRequest.memo || '')}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 자동 실행 결제 QR 코드 HTML 뷰어 페이지
   */
  @Get('auto-payment/view')
  @Header('Content-Type', 'text/html')
  async viewAutoPaymentQR(
    @Res({ passthrough: false }) res: Response,
    @Query('amount') amount?: string,
    @Query('token') token?: string,
    @Query('memo') memo?: string,
  ) {
    try {
      const paymentRequest: PaymentRequest = {
        to: process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8',
        amount: amount || '0.001',
        token: token || process.env.TOKEN || 'ETH',
        memo: memo || 'Auto Payment Request',
        chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111,
        autoExecute: true,
      };

      const qrCode = await this.qrService.generatePaymentQR(paymentRequest);
      const executionUrl = `${process.env.SERVER_URL || 'http://localhost:4123'}/qr/execute?to=${paymentRequest.to}&amount=${paymentRequest.amount}&token=${paymentRequest.token}&chainId=${paymentRequest.chainId}&memo=${encodeURIComponent(paymentRequest.memo || '')}`;
      
      const html = `
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>자동 실행 결제 QR 코드</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0;
              padding: 20px;
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
            }
            .container {
              background: white;
              border-radius: 15px;
              box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
              padding: 40px;
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            h1 {
              color: #333;
              margin-bottom: 30px;
              font-size: 24px;
              font-weight: 600;
            }
            .auto-badge {
              background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
              color: white;
              padding: 15px;
              border-radius: 10px;
              margin-bottom: 20px;
              font-size: 16px;
              animation: pulse 2s infinite;
            }
            @keyframes pulse {
              0% { box-shadow: 0 0 0 0 rgba(245, 87, 108, 0.7); }
              70% { box-shadow: 0 0 0 10px rgba(245, 87, 108, 0); }
              100% { box-shadow: 0 0 0 0 rgba(245, 87, 108, 0); }
            }
            .auto-icon {
              font-size: 32px;
              margin-bottom: 10px;
            }
            .qr-container {
              margin: 30px 0;
              padding: 20px;
              background: #f8f9fa;
              border-radius: 10px;
              border: 2px dashed #dee2e6;
            }
            .qr-code {
              max-width: 100%;
              height: auto;
              border-radius: 8px;
            }
            .payment-info {
              background: #e9ecef;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              text-align: left;
              border: 1px solid #ced4da;
            }
            .payment-info h3 {
              margin-top: 0;
              color: #495057;
              font-size: 16px;
            }
            .payment-item {
              display: flex;
              justify-content: space-between;
              margin: 10px 0;
              padding: 8px 0;
              border-bottom: 1px solid #dee2e6;
            }
            .payment-item:last-child {
              border-bottom: none;
            }
            .payment-label {
              font-weight: 600;
              color: #495057;
            }
            .payment-value {
              color: #6c757d;
              font-family: 'Courier New', monospace;
              word-break: break-all;
            }
            .highlight-box {
              background: #fff3cd;
              border: 2px solid #ffc107;
              border-radius: 8px;
              padding: 15px;
              margin: 20px 0;
            }
            .highlight-box h3 {
              color: #856404;
              margin-top: 0;
            }
            .highlight-box p {
              color: #856404;
              margin: 5px 0;
              font-size: 14px;
            }
            .info {
              color: #6c757d;
              font-size: 14px;
              margin-top: 20px;
              line-height: 1.5;
            }
            .test-btn {
              background: #28a745;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 15px;
              transition: background 0.3s;
              text-decoration: none;
              display: inline-block;
            }
            .test-btn:hover {
              background: #1e7e34;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🚀 자동 실행 결제 QR 코드</h1>
            
            <div class="auto-badge">
              <div class="auto-icon">⚡</div>
              <strong>자동 실행 모드 활성화</strong><br>
              <small>QR 스캔 시 즉시 결제 페이지로 이동합니다</small>
            </div>
            
            <div class="qr-container">
              <img src="${qrCode}" alt="자동 실행 결제 QR 코드" class="qr-code">
            </div>
            
            <div class="highlight-box">
              <h3>📱 사용 방법</h3>
              <p>1. 모바일 기기로 QR 코드를 스캔합니다</p>
              <p>2. 자동으로 결제 실행 페이지로 이동합니다</p>
              <p>3. 개인키를 입력하여 결제를 완료합니다</p>
            </div>
            
            <div class="payment-info">
              <h3>결제 정보 (테스트넷)</h3>
              <div class="payment-item">
                <span class="payment-label">네트워크:</span>
                <span class="payment-value">Sepolia Testnet</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">받는 주소:</span>
                <span class="payment-value">${paymentRequest.to}</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">금액:</span>
                <span class="payment-value">${paymentRequest.amount}</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">토큰:</span>
                <span class="payment-value">${paymentRequest.token}</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">메모:</span>
                <span class="payment-value">${paymentRequest.memo}</span>
              </div>
              <div class="payment-item" style="background: #d4edda; padding: 10px; border-radius: 5px; border: none;">
                <span class="payment-label">가스비:</span>
                <span class="payment-value" style="color: #155724; font-weight: bold;">받는 쪽에서 대납 ✅</span>
              </div>
            </div>
            
            <a href="${executionUrl}" class="test-btn" target="_blank">
              🧪 웹에서 테스트하기
            </a>
            
            <div class="info">
              <strong>⚠️ 주의사항</strong><br>
              • 이것은 테스트넷(Sepolia)용 QR 코드입니다<br>
              • 실제 자금이 아닌 테스트 토큰만 사용하세요<br>
              • 개인키는 안전하게 보관하세요
            </div>
          </div>
        </body>
        </html>
      `;
      
      res.send(html);
    } catch (error) {
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>오류</title></head>
        <body>
          <div style="text-align: center; margin-top: 50px;">
            <h1>QR 코드 생성 오류</h1>
            <p>${error.message}</p>
          </div>
        </body>
        </html>
      `;
      res.status(500).send(errorHtml);
    }
  }

  /**
   * 결제 QR 코드 생성 API
   */
  @Post('payment')
  async generatePaymentQR(@Body() paymentRequest: PaymentRequest) {
    try {
      // 체인 ID 설정 (환경변수 사용)
      const requestWithChain: PaymentRequest = {
        ...paymentRequest,
        chainId: paymentRequest.chainId || (process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111)
      };
      
      const qrCode = await this.qrService.generatePaymentQR(requestWithChain);
      return {
        success: true,
        qrCode,
        data: requestWithChain,
        chainId: requestWithChain.chainId,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 기본 지갑 주소 QR 코드 생성 API
   */
  @Get('wallet')
  async generateWalletQR(@Query('address') address?: string) {
    try {
      // 테스트넷 기본 지갑 주소 설정
      const walletAddress = address || process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8';
      const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111;
      const qrCode = await this.qrService.generateWalletAddressQR(walletAddress, chainId);
      
      return {
        success: true,
        qrCode,
        address: walletAddress,
        chainId,
        network: 'Sepolia Testnet',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 기본 결제 요청 QR 코드 생성 (GET 방식)
   */
  @Get('payment')
  async generateDefaultPaymentQR(
    @Query('amount') amount?: string,
    @Query('token') token?: string,
    @Query('memo') memo?: string,
  ) {
    try {
      const paymentRequest: PaymentRequest = {
        to: process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8',
        amount: amount || '0.001',
        token: token || process.env.TOKEN || 'ETH',
        memo: memo || 'Payment Request',
        chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111,
      };

      const qrCode = await this.qrService.generatePaymentQR(paymentRequest);
      return {
        success: true,
        qrCode,
        data: paymentRequest,
        chainId: paymentRequest.chainId,
        network: 'Sepolia Testnet',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 지갑 주소 QR 코드 HTML 페이지로 보기
   */
  @Get('wallet/view')
  @Header('Content-Type', 'text/html')
  async viewWalletQR(
    @Res({ passthrough: false }) res: Response,
    @Query('address') address?: string,
  ) {
    try {
      const walletAddress = address || process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8';
      const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111;
      const qrCode = await this.qrService.generateWalletAddressQR(walletAddress, chainId);
      
      const html = `
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>지갑 주소 QR 코드</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0;
              padding: 20px;
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
            }
            .container {
              background: white;
              border-radius: 15px;
              box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
              padding: 40px;
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            h1 {
              color: #333;
              margin-bottom: 30px;
              font-size: 24px;
              font-weight: 600;
            }
            .qr-container {
              margin: 30px 0;
              padding: 20px;
              background: #f8f9fa;
              border-radius: 10px;
              border: 2px dashed #dee2e6;
            }
            .qr-code {
              max-width: 100%;
              height: auto;
              border-radius: 8px;
            }
            .address {
              background: #e9ecef;
              padding: 15px;
              border-radius: 8px;
              margin: 20px 0;
              word-break: break-all;
              font-family: 'Courier New', monospace;
              font-size: 14px;
              color: #495057;
              border: 1px solid #ced4da;
            }
            .info {
              color: #6c757d;
              font-size: 14px;
              margin-top: 20px;
              line-height: 1.5;
            }
            .refresh-btn {
              background: #007bff;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 15px;
              transition: background 0.3s;
            }
            .refresh-btn:hover {
              background: #0056b3;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>💳 지갑 주소 QR 코드 (테스트넷)</h1>
            <div class="qr-container">
              <img src="${qrCode}" alt="지갑 주소 QR 코드" class="qr-code">
            </div>
            <div class="address">
              <strong>지갑 주소:</strong><br>
              ${walletAddress}
            </div>
            <div class="info">
              <strong>🔧 테스트넷 (Sepolia)</strong><br>
              이 QR 코드를 스캔하여 테스트넷 지갑 주소를 쉽게 복사할 수 있습니다.<br>
              <small>⚠️ 실제 자금이 아닌 테스트 토큰만 사용하세요!</small>
            </div>
            <button class="refresh-btn" onclick="location.reload()">새로고침</button>
          </div>
        </body>
        </html>
      `;
      
      res.send(html);
    } catch (error) {
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>오류</title></head>
        <body>
          <div style="text-align: center; margin-top: 50px;">
            <h1>QR 코드 생성 오류</h1>
            <p>${error.message}</p>
          </div>
        </body>
        </html>
      `;
      res.status(500).send(errorHtml);
    }
  }

  /**
   * 결제 QR 코드 HTML 페이지로 보기
   */
  @Get('payment/view')
  @Header('Content-Type', 'text/html')
  async viewPaymentQR(
    @Res({ passthrough: false }) res: Response,
    @Query('amount') amount?: string,
    @Query('token') token?: string,
    @Query('memo') memo?: string,
  ) {
    try {
      const paymentRequest: PaymentRequest = {
        to: process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8',
        amount: amount || '0.001',
        token: token || process.env.TOKEN || 'ETH',
        memo: memo || 'Payment Request',
        chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111,
      };

      const qrCode = await this.qrService.generatePaymentQR(paymentRequest);
      
      const html = `
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>결제 요청 QR 코드</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0;
              padding: 20px;
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
            }
            .container {
              background: white;
              border-radius: 15px;
              box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
              padding: 40px;
              text-align: center;
              max-width: 500px;
              width: 100%;
            }
            h1 {
              color: #333;
              margin-bottom: 30px;
              font-size: 24px;
              font-weight: 600;
            }
            .gas-sponsor-info {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 15px;
              border-radius: 10px;
              margin-bottom: 20px;
              font-size: 14px;
              animation: pulse 2s infinite;
            }
            @keyframes pulse {
              0% { box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.7); }
              70% { box-shadow: 0 0 0 10px rgba(102, 126, 234, 0); }
              100% { box-shadow: 0 0 0 0 rgba(102, 126, 234, 0); }
            }
            .gas-sponsor-info h3 {
              margin: 0 0 10px 0;
              font-size: 16px;
            }
            .gas-sponsor-icon {
              font-size: 24px;
              margin-bottom: 5px;
            }
            .qr-container {
              margin: 30px 0;
              padding: 20px;
              background: #f8f9fa;
              border-radius: 10px;
              border: 2px dashed #dee2e6;
            }
            .qr-code {
              max-width: 100%;
              height: auto;
              border-radius: 8px;
            }
            .payment-info {
              background: #e9ecef;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              text-align: left;
              border: 1px solid #ced4da;
            }
            .payment-info h3 {
              margin-top: 0;
              color: #495057;
              font-size: 16px;
            }
            .payment-item {
              display: flex;
              justify-content: space-between;
              margin: 10px 0;
              padding: 8px 0;
              border-bottom: 1px solid #dee2e6;
            }
            .payment-item:last-child {
              border-bottom: none;
            }
            .payment-label {
              font-weight: 600;
              color: #495057;
            }
            .payment-value {
              color: #6c757d;
              font-family: 'Courier New', monospace;
              word-break: break-all;
            }
            .info {
              color: #6c757d;
              font-size: 14px;
              margin-top: 20px;
              line-height: 1.5;
            }
            .refresh-btn {
              background: #28a745;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 15px;
              transition: background 0.3s;
            }
            .refresh-btn:hover {
              background: #1e7e34;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>💰 결제 요청 QR 코드 (테스트넷)</h1>
            
            <div class="gas-sponsor-info">
              <div class="gas-sponsor-icon">⛽</div>
              <h3>🎉 가스비 무료!</h3>
              <div>받는 쪽에서 가스비를 대납합니다</div>
              <div style="font-size: 12px; margin-top: 5px;">보내는 분은 가스비 걱정 없이 결제하실 수 있습니다</div>
            </div>
            
            <div class="qr-container">
              <img src="${qrCode}" alt="결제 요청 QR 코드" class="qr-code">
            </div>
            <div class="payment-info">
              <h3>결제 정보 (테스트넷)</h3>
              <div class="payment-item">
                <span class="payment-label">네트워크:</span>
                <span class="payment-value">Sepolia Testnet</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">받는 주소:</span>
                <span class="payment-value">${paymentRequest.to}</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">금액:</span>
                <span class="payment-value">${paymentRequest.amount}</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">토큰:</span>
                <span class="payment-value">${paymentRequest.token}</span>
              </div>
              <div class="payment-item">
                <span class="payment-label">메모:</span>
                <span class="payment-value">${paymentRequest.memo}</span>
              </div>
              <div class="payment-item" style="background: #d4edda; padding: 10px; border-radius: 5px; border: none;">
                <span class="payment-label">가스비:</span>
                <span class="payment-value" style="color: #155724; font-weight: bold;">받는 쪽에서 대납 ✅</span>
              </div>
            </div>
            <div class="info">
              <strong>🔧 테스트넷 (Sepolia)</strong><br>
              이 QR 코드를 스캔하여 테스트넷에서 결제를 진행할 수 있습니다.<br>
              <strong style="color: #28a745;">💚 가스비는 받는 쪽에서 대납하므로 보내는 분은 ETH가 없어도 됩니다!</strong><br>
              <small>⚠️ 실제 자금이 아닌 테스트 토큰만 사용하세요!</small>
            </div>
            <button class="refresh-btn" onclick="location.reload()">새로고침</button>
          </div>
        </body>
        </html>
      `;
      
      res.send(html);
    } catch (error) {
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>오류</title></head>
        <body>
          <div style="text-align: center; margin-top: 50px;">
            <h1>QR 코드 생성 오류</h1>
            <p>${error.message}</p>
          </div>
        </body>
        </html>
      `;
      res.status(500).send(errorHtml);
    }
  }

  /**
   * QR 코드에 포함된 URI 텍스트 확인 (디버깅용)
   */
  @Get('payment/uri')
  async getPaymentURI(
    @Query('amount') amount?: string,
    @Query('token') token?: string,
    @Query('memo') memo?: string,
  ) {
    try {
      const paymentRequest: PaymentRequest = {
        to: process.env.TO || '0x742d35Cc6634C0532925a3b8D5c1c9c8fFd5b1b8',
        amount: amount || '0.001',
        token: token || process.env.TOKEN || 'ETH',
        memo: memo || 'Payment Request',
        chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111,
      };

      // URI 텍스트 생성
      const uriText = await this.qrService.generatePaymentURI(paymentRequest);
      
      return {
        success: true,
        uri: uriText,
        data: paymentRequest,
        note: 'EIP-681 표준 URI 형태입니다. MetaMask에서 이 URI를 인식할 수 있어야 합니다.'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
} 
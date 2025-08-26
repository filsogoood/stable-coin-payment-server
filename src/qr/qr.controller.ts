import { Controller, Post, Body, Get, Query, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { QrService } from './qr.service';
import type { PaymentRequest } from './qr.service';

@Controller('qr')
export class QrController {
  constructor(private readonly qrService: QrService) {}

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
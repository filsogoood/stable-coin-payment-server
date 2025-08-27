import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { CryptoService, EncryptedPaymentData, EncryptedPrivateKeyData, EncryptedPaymentOnlyData } from './crypto.service';
import type { Response } from 'express';
import * as path from 'path';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly cryptoService: CryptoService
  ) {}

  // 메인 페이지
  @Get()
  getMain(@Res() res: Response) {
    return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  }

  // QR 스캔 페이지
  @Get('scan')
  getScan(@Res() res: Response) {
    return res.sendFile(path.join(process.cwd(), 'public', 'scan.html'));
  }



  // 유저 결제 요청
  @Post('payment')
  async payment(@Body() body: any) {
    return this.appService.payment(body);
  }

  // 가스리스 결제 요청 (서버에서 client.ts 실행)
  @Post('gasless-payment')
  async gaslessPayment(@Body() body: any) {
    return this.appService.gaslessPayment(body);
  }

  // ============================================
  // 암호화 기반 엔드포인트들 (CryptoService 사용)
  // ============================================

  // 2개 암호화된 QR 코드 생성
  @Post('crypto/create-two-qr')
  async createTwoEncryptedQR(@Body() body: any): Promise<{
    status: string;
    message: string;
    privateKeyQR: EncryptedPrivateKeyData;
    paymentQR: EncryptedPaymentOnlyData;
    sessionId: string;
    timestamp: string;
  }> {
    console.log('[2개 암호화 QR 생성] 요청 데이터:', JSON.stringify(body, null, 2));
    
    const { privateKey, paymentData } = body;
    
    if (!privateKey || !paymentData) {
      console.error('[2개 암호화 QR 생성] 필수 데이터 누락:', { privateKey: !!privateKey, paymentData: !!paymentData });
      throw new Error('필수 데이터가 누락되었습니다.');
    }

    // 세션 ID 생성
    const sessionId = `crypto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 1. 개인키 암호화
    const encryptedPrivateKey = this.cryptoService.encryptPrivateKey(privateKey, sessionId);

    // 2. 결제정보 암호화 (개인키 제외)
    const paymentOnlyData = {
      amount: paymentData.amount,
      recipient: paymentData.recipient,
      token: paymentData.token,
      chainId: paymentData.chainId,
      serverUrl: paymentData.serverUrl,
      rpcUrl: paymentData.rpcUrl,
      delegateAddress: paymentData.delegateAddress,
      sessionId,
      timestamp: Date.now()
    };

    const encryptedPaymentOnly = this.cryptoService.encryptPaymentOnly(paymentOnlyData);

    console.log('[2개 암호화 QR 생성] 암호화 완료');

    return {
      status: 'success',
      message: '2개의 암호화된 QR 코드가 생성되었습니다.',
      privateKeyQR: encryptedPrivateKey,
      paymentQR: encryptedPaymentOnly,
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  // 첫 번째 QR 스캔: 개인키 저장
  @Post('crypto/scan-private-key')
  async scanPrivateKey(@Body() body: any) {
    console.log('[개인키 QR 스캔] 요청 시작');
    
    try {
      // 개인키 복호화 및 저장
      const result = this.cryptoService.decryptAndStorePrivateKey(body);
      
      console.log('[개인키 QR 스캔] 성공:', result.sessionId);

      return {
        status: 'success',
        message: '개인키가 안전하게 저장되었습니다. 이제 결제정보 QR 코드를 스캔해주세요.',
        sessionId: result.sessionId,
        nextStep: 'scan_payment_qr',
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('[개인키 QR 스캔] 실패:', error.message);
      throw error;
    }
  }

  // 두 번째 QR 스캔: 결제정보 + 결제 실행
  @Post('crypto/scan-payment-data')
  async scanPaymentData(@Body() body: any) {
    console.log('[결제정보 QR 스캔] 요청 시작');
    
    try {
      // 결제정보 복호화 및 개인키와 결합
      const completePaymentData = this.cryptoService.decryptPaymentOnlyAndCombine(body);
      
      console.log('[결제정보 QR 스캔] 복호화 및 결합 성공, 수신자:', this.cryptoService.shortenAddress(completePaymentData.recipient));
      
      // 기존 가스리스 결제 로직 사용
      const paymentResult = await this.appService.gaslessPayment({
        qrData: {
          ...completePaymentData,
          to: completePaymentData.recipient,
          amountWei: completePaymentData.amount
        }
      });

      console.log('[결제정보 QR 스캔] 결제 처리 완료');

      return {
        status: 'success',
        message: '2단계 암호화 QR 결제가 성공적으로 완료되었습니다.',
        paymentResult,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('[결제정보 QR 스캔] 실패:', error.message);
      throw error;
    }
  }

  // 기존 단일 QR 스캔 (호환성 유지)
  @Post('crypto/scan-payment')
  async scanEncryptedPayment(@Body() body: any) {
    console.log('[단일 암호화 QR 스캔] 요청 시작');
    
    try {
      // 암호화된 데이터 복호화
      const paymentData = this.cryptoService.decryptPaymentData(body);
      
      console.log('[단일 암호화 QR 스캔] 복호화 성공, 수신자:', this.cryptoService.shortenAddress(paymentData.recipient));
      
      // 기존 가스리스 결제 로직 사용
      const paymentResult = await this.appService.gaslessPayment({
        qrData: {
          ...paymentData,
          to: paymentData.recipient,
          amountWei: paymentData.amount
        }
      });

      console.log('[단일 암호화 QR 스캔] 결제 처리 완료');

      return {
        status: 'success',
        message: '암호화된 QR 결제가 성공적으로 완료되었습니다.',
        paymentResult,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('[단일 암호화 QR 스캔] 실패:', error.message);
      throw error;
    }
  }

  // 암호화 정보 확인 (디버깅용)
  @Get('crypto/info')
  getCryptoInfo() {
    return this.cryptoService.getEncryptionInfo();
  }

  // 저장된 개인키 상태 확인 (디버깅용)
  @Get('crypto/private-key-stats')
  getPrivateKeyStats() {
    return this.cryptoService.getStoredPrivateKeyStats();
  }
}
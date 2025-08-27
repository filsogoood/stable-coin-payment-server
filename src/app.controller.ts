import { Body, Controller, Get, Post, Res, Param } from '@nestjs/common';
import { AppService } from './app.service';
import { SessionService } from './session.service';
import { CryptoService, EncryptedPaymentData, EncryptedPrivateKeyData, EncryptedPaymentOnlyData } from './crypto.service';
import type { Response } from 'express';
import * as path from 'path';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly sessionService: SessionService,
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

  // 2단계 QR 스캔 페이지
  @Get('scan-v2')
  getScanV2(@Res() res: Response) {
    return res.sendFile(path.join(process.cwd(), 'public', 'scan-v2.html'));
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

  // 개인키 세션 저장 (첫 번째 QR 스캔) - 기존 세션 방식
  @Post('scan/private-key')
  async scanPrivateKeySession(@Body() body: any) {
    const { type, sessionId, privateKey, scanUrl, expiresAt, timestamp } = body;
    
    if (type !== 'private_key_session') {
      throw new Error('잘못된 QR 코드 타입입니다.');
    }

    this.sessionService.storePrivateKeySession({
      sessionId,
      privateKey,
      scanUrl,
      expiresAt,
      timestamp
    });

    return {
      status: 'success',
      message: '개인키가 안전하게 저장되었습니다. 이제 결제정보 QR 코드를 스캔해주세요.',
      sessionId,
      nextStep: 'scan_payment_qr'
    };
  }

  // 결제 세션 저장 및 결제 실행 (두 번째 QR 스캔)
  @Post('scan/payment')
  async scanPayment(@Body() body: any) {
    const { type, sessionId, amount, recipient, token, chainId, serverUrl, rpcUrl, delegateAddress, timestamp } = body;
    
    if (type !== 'payment_request') {
      throw new Error('잘못된 QR 코드 타입입니다.');
    }

    // 결제 세션 저장
    this.sessionService.storePaymentSession({
      sessionId,
      amount,
      recipient,
      token,
      chainId,
      serverUrl,
      rpcUrl,
      delegateAddress,
      timestamp
    });

    // 세션 결합 및 결제 실행
    const completedSession = this.sessionService.combineSessionsForPayment(sessionId);
    
    // 기존 가스리스 결제 로직 사용
    const paymentResult = await this.appService.gaslessPayment({
      qrData: {
        ...completedSession.paymentData,
        privateKey: completedSession.privateKey,
        to: completedSession.paymentData.recipient,
        amountWei: completedSession.paymentData.amount
      }
    });

    // 사용된 세션 정리
    this.sessionService.cleanupSession(sessionId);

    return {
      status: 'success',
      message: '결제가 성공적으로 완료되었습니다.',
      sessionId,
      paymentResult
    };
  }

  // 세션 상태 확인 (디버깅용)
  @Get('session/stats')
  getSessionStats() {
    console.log('[디버그] 세션 상태 조회 요청');
    const stats = this.sessionService.getSessionStats();
    console.log('[디버그] 현재 세션 상태:', stats);
    return stats;
  }

  // 모든 세션 목록 조회 (디버깅용)
  @Get('debug/sessions')
  getDebugSessions() {
    const result = this.sessionService.getAllSessionsForDebug();
    console.log('[디버그] 전체 세션 목록:', result);
    return result;
  }

  // 세션 생성 (QR 생성 시 호출)
  @Post('session/create')
  async createSession(@Body() body: any) {
    console.log('[세션 생성] 요청 데이터:', JSON.stringify(body, null, 2));
    
    const { sessionId, privateKey, paymentData } = body;
    
    if (!sessionId || !privateKey || !paymentData) {
      console.error('[세션 생성] 필수 데이터 누락:', { sessionId: !!sessionId, privateKey: !!privateKey, paymentData: !!paymentData });
      throw new Error('필수 데이터가 누락되었습니다.');
    }

    console.log(`[세션 생성] 세션 ID: ${sessionId}`);
    
    // 개인키 세션 저장
    this.sessionService.storePrivateKeySession({
      sessionId,
      privateKey,
      scanUrl: `${paymentData.serverUrl}/scan`,
      expiresAt: Date.now() + (10 * 60 * 1000), // 10분 후 만료
      timestamp: Date.now()
    });

    // 결제 세션 저장
    this.sessionService.storePaymentSession({
      sessionId,
      amount: paymentData.amount,
      recipient: paymentData.recipient,
      token: paymentData.token,
      chainId: paymentData.chainId,
      serverUrl: paymentData.serverUrl,
      rpcUrl: paymentData.rpcUrl,
      delegateAddress: paymentData.delegateAddress,
      timestamp: Date.now()
    });

    console.log(`[세션 생성] 세션 저장 완료: ${sessionId}`);

    return {
      status: 'success',
      message: '세션이 생성되었습니다.',
      sessionId,
      scanUrl: `${paymentData.serverUrl}/scan?session=${sessionId}`
    };
  }

  // 세션 정보 조회 (스캔 페이지에서 사용)
  @Get('session/:sessionId')
  getSession(@Param('sessionId') sessionId: string) {
    console.log(`[세션 조회] 요청된 세션 ID: ${sessionId}`);
    
    const hasPrivateKey = this.sessionService.hasPrivateKeySession(sessionId);
    const hasPaymentData = this.sessionService.hasPaymentSession(sessionId);
    
    console.log(`[세션 조회] 개인키 세션 존재: ${hasPrivateKey}`);
    console.log(`[세션 조회] 결제 세션 존재: ${hasPaymentData}`);
    
    // 현재 세션 상태 출력
    const stats = this.sessionService.getSessionStats();
    console.log(`[세션 조회] 현재 세션 상태:`, stats);
    
    if (!hasPrivateKey || !hasPaymentData) {
      console.error(`[세션 조회] 세션을 찾을 수 없습니다: ${sessionId}`);
      throw new Error('세션을 찾을 수 없습니다.');
    }

    console.log(`[세션 조회] 세션 조회 성공: ${sessionId}`);

    return {
      status: 'success',
      sessionId,
      hasPrivateKey,
      hasPaymentData,
      message: '세션 정보를 찾았습니다. 결제정보 QR을 스캔해주세요.',
      timestamp: new Date().toISOString()
    };
  }

  // 세션 상태 확인 (특정 세션)
  @Get('session/:sessionId/status')
  getSessionStatus(@Param('sessionId') sessionId: string) {
    return {
      sessionId,
      hasPrivateKey: this.sessionService.hasPrivateKeySession(sessionId),
      hasPaymentData: this.sessionService.hasPaymentSession(sessionId),
      timestamp: new Date().toISOString()
    };
  }

  // ============================================
  // 새로운 암호화 기반 엔드포인트들
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

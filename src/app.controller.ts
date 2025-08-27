import { Body, Controller, Get, Post, Res, Param } from '@nestjs/common';
import { AppService } from './app.service';
import { SessionService } from './session.service';
import type { Response } from 'express';
import * as path from 'path';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly sessionService: SessionService
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

  // 개인키 세션 저장 (첫 번째 QR 스캔)
  @Post('scan/private-key')
  async scanPrivateKey(@Body() body: any) {
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
}

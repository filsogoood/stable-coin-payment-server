import { Body, Controller, Get, Post, Res, Logger } from '@nestjs/common';
import { AppService } from './app.service';

import type { Response } from 'express';
import * as path from 'path';

@Controller()
export class AppController {
  private readonly logger = new Logger('AppController');
  
  constructor(private readonly appService: AppService) {}

  // 메인 페이지
  @Get()
  getMain(@Res() res: Response) {
    this.logger.log('[GET /] 메인 페이지 요청');
    try {
      const result = res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
      this.logger.log('[GET /] 메인 페이지 응답 완료');
      return result;
    } catch (error: any) {
      this.logger.error('[GET /] 메인 페이지 오류:', error.message);
      throw error;
    }
  }

  // QR 스캔 페이지
  @Get('scan')
  getScan(@Res() res: Response) {
    this.logger.log('[GET /scan] QR 스캔 페이지 요청');
    try {
      const result = res.sendFile(path.join(process.cwd(), 'public', 'scan.html'));
      this.logger.log('[GET /scan] QR 스캔 페이지 응답 완료');
      return result;
    } catch (error: any) {
      this.logger.error('[GET /scan] QR 스캔 페이지 오류:', error.message);
      throw error;
    }
  }

  // 유저 결제 요청
  @Post('payment')
  async payment(@Body() body: any) {
    this.logger.log('[POST /payment] 유저 결제 요청 시작');
    this.logger.debug('[POST /payment] 요청 body:', JSON.stringify(body, null, 2));
    try {
      const result = await this.appService.payment(body);
      this.logger.log('[POST /payment] 유저 결제 완료:', JSON.stringify(result));
      return result;
    } catch (error: any) {
      this.logger.error('[POST /payment] 유저 결제 오류:', error.message);
      throw error;
    }
  }

  // 가스리스 결제 요청 (서버에서 client.ts 실행)
  @Post('gasless-payment')
  async gaslessPayment(@Body() body: any) {
    this.logger.log('[POST /gasless-payment] 가스리스 결제 요청 시작');
    this.logger.debug('[POST /gasless-payment] 요청 body:', JSON.stringify(body, null, 2));
    try {
      const result = await this.appService.gaslessPayment(body);
      this.logger.log('[POST /gasless-payment] 가스리스 결제 완료:', JSON.stringify(result));
      return result;
    } catch (error: any) {
      this.logger.error('[POST /gasless-payment] 가스리스 결제 오류:', error.message);
      throw error;
    }
  }

  // QR 스캔 결제 - 개인키 세션 저장
  @Post('scan/private-key')
  async storePrivateKeySession(@Body() body: any) {
    this.logger.log('[POST /scan/private-key] 개인키 세션 저장 요청 시작');
    this.logger.debug('[POST /scan/private-key] 요청 body (개인키 제외):', {
      ...body,
      encryptedPrivateKey: body.encryptedPrivateKey ? '[ENCRYPTED]' : undefined
    });
    try {
      const result = await this.appService.storePrivateKeySession(body);
      this.logger.log('[POST /scan/private-key] 개인키 세션 저장 완료:', JSON.stringify(result));
      return result;
    } catch (error: any) {
      this.logger.error('[POST /scan/private-key] 개인키 세션 저장 오류:', error.message);
      throw error;
    }
  }

  // QR 스캔 결제 - 결제 실행
  @Post('scan/payment')
  async scanPayment(@Body() body: any) {
    this.logger.log('[POST /scan/payment] QR 스캔 결제 실행 요청 시작');
    this.logger.debug('[POST /scan/payment] 요청 body:', JSON.stringify(body, null, 2));
    try {
      const result = await this.appService.scanPayment(body);
      this.logger.log('[POST /scan/payment] QR 스캔 결제 실행 완료:', JSON.stringify(result));
      return result;
    } catch (error: any) {
      this.logger.error('[POST /scan/payment] QR 스캔 결제 실행 오류:', error.message);
      throw error;
    }
  }

  // 영수증 인쇄 요청
  @Post('receipt/print')
  async printReceipt(@Body() body: any) {
    this.logger.log('[POST /receipt/print] 영수증 인쇄 요청 시작');
    this.logger.debug('[POST /receipt/print] 요청 body:', JSON.stringify(body, null, 2));
    try {
      const result = await this.appService.printReceipt(body);
      this.logger.log('[POST /receipt/print] 영수증 인쇄 요청 완료:', JSON.stringify(result));
      return result;
    } catch (error: any) {
      this.logger.error('[POST /receipt/print] 영수증 인쇄 요청 오류:', error.message);
      throw error;
    }
  }

  // 인쇄 대기열 조회 (Android APP 폴링용)
  @Get('api/receipt/queue')
  async getPrintQueue() {
    try {
      const result = await this.appService.getPrintQueue();
      return result;
    } catch (error: any) {
      throw error;
    }
  }

  // 인쇄 상태 업데이트 (Android APP에서 인쇄 완료/실패 알림)
  @Post('api/receipt/status')
  async updatePrintStatus(@Body() body: { printId: string; status: string; errorMessage?: string }) {
    this.logger.log('[POST /api/receipt/status] 인쇄 상태 업데이트 요청 시작');
    this.logger.debug('[POST /api/receipt/status] 요청 body:', JSON.stringify(body, null, 2));
    try {
      const result = await this.appService.updatePrintStatus(body.printId, body.status as any, body.errorMessage);
      this.logger.log('[POST /api/receipt/status] 인쇄 상태 업데이트 완료:', JSON.stringify(result));
      return result;
    } catch (error: any) {
      this.logger.error('[POST /api/receipt/status] 인쇄 상태 업데이트 오류:', error.message);
      throw error;
    }
  }

  // 인쇄 대기열 통계
  @Get('api/receipt/stats')
  async getPrintQueueStats() {
    this.logger.debug('[GET /api/receipt/stats] 인쇄 대기열 통계 요청');
    try {
      const result = await this.appService.getPrintQueueStats();
      this.logger.debug('[GET /api/receipt/stats] 인쇄 대기열 통계 완료');
      return result;
    } catch (error: any) {
      this.logger.error('[GET /api/receipt/stats] 인쇄 대기열 통계 오류:', error.message);
      throw error;
    }
  }

  // 지갑 잔고 조회 (개인키로)
  @Post('api/wallet/balance')
  async getWalletBalanceByPrivateKey(@Body() body: { privateKey: string }) {
    this.logger.log('[POST /api/wallet/balance] 지갑 잔고 조회 요청 시작');
    this.logger.debug('[POST /api/wallet/balance] 개인키 마스킹:', {
      privateKey: body.privateKey ? body.privateKey.substring(0, 10) + '...' : undefined
    });
    try {
      const result = await this.appService.getWalletBalanceByPrivateKey(body.privateKey);
      this.logger.log('[POST /api/wallet/balance] 지갑 잔고 조회 완료');
      return result;
    } catch (error: any) {
      this.logger.error('[POST /api/wallet/balance] 지갑 잔고 조회 오류:', error.message);
      throw error;
    }
  }

  // 클라이언트용 환경변수 제공
  @Get('api/config')
  getClientConfig() {
    this.logger.debug('[GET /api/config] 클라이언트 설정 요청');
    try {
      const config = {
        serverUrl: process.env.SERVER_URL || 'http://localhost:4123',
        chainId: process.env.CHAIN_ID || '11155111',
        token: process.env.TOKEN,
        rpcUrl: process.env.RPC_URL
      };
      this.logger.debug('[GET /api/config] 클라이언트 설정 응답:', JSON.stringify(config));
      return config;
    } catch (error: any) {
      this.logger.error('[GET /api/config] 클라이언트 설정 오류:', error.message);
      throw error;
    }
  }

  // EOA nonce 조회
  @Post('api/eoa-nonce')
  async getEOANonce(@Body() body: any) {
    this.logger.debug('[POST /api/eoa-nonce] EOA nonce 조회 요청:', body);
    try {
      const { authority } = body;
      const nonce = await this.appService.getEOANonce(authority);
      this.logger.debug('[POST /api/eoa-nonce] EOA nonce 조회 성공:', { authority, nonce });
      return { nonce };
    } catch (error: any) {
      this.logger.error('[POST /api/eoa-nonce] EOA nonce 조회 오류:', error.message);
      throw error;
    }
  }

  // Transfer 데이터 준비
  @Post('api/prepare-transfer')
  async prepareTransfer(@Body() body: any) {
    this.logger.debug('[POST /api/prepare-transfer] Transfer 데이터 준비 요청:', body);
    try {
      const result = await this.appService.prepareTransferData(body);
      this.logger.debug('[POST /api/prepare-transfer] Transfer 데이터 준비 성공:', result);
      return result;
    } catch (error: any) {
      this.logger.error('[POST /api/prepare-transfer] Transfer 데이터 준비 오류:', error.message);
      throw error;
    }
  }

  // 서명된 결제 처리
  @Post('payment-signed')
  async paymentSigned(@Body() body: any) {
    this.logger.log('[POST /payment-signed] 서명된 결제 요청 시작');
    this.logger.debug('[POST /payment-signed] 요청 body:', body);
    
    try {
      const result = await this.appService.processSignedPayment(body);
      this.logger.log('[POST /payment-signed] 서명된 결제 성공:', result);
      return result;
    } catch (error: any) {
      this.logger.error('[POST /payment-signed] 서명된 결제 오류:', error.message);
      throw error;
    }
  }
}

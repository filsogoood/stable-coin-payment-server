import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { AppService } from './app.service';

import type { Response } from 'express';
import * as path from 'path';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

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

  // QR 스캔 결제 - 개인키 세션 저장
  @Post('scan/private-key')
  async storePrivateKeySession(@Body() body: any) {
    return this.appService.storePrivateKeySession(body);
  }

  // QR 스캔 결제 - 결제 실행
  @Post('scan/payment')
  async scanPayment(@Body() body: any) {
    return this.appService.scanPayment(body);
  }

  // 영수증 인쇄 요청
  @Post('receipt/print')
  async printReceipt(@Body() body: any) {
    return this.appService.printReceipt(body);
  }

  // 인쇄 대기열 조회 (Android APP 폴링용)
  @Get('api/receipt/queue')
  async getPrintQueue() {
    return this.appService.getPrintQueue();
  }

  // 인쇄 상태 업데이트 (Android APP에서 인쇄 완료/실패 알림)
  @Post('api/receipt/status')
  async updatePrintStatus(@Body() body: { printId: string; status: string; errorMessage?: string }) {
    return this.appService.updatePrintStatus(body.printId, body.status as any, body.errorMessage);
  }

  // 인쇄 대기열 통계
  @Get('api/receipt/stats')
  async getPrintQueueStats() {
    return this.appService.getPrintQueueStats();
  }

  // 지갑 잔고 조회 (개인키로)
  @Post('api/wallet/balance')
  async getWalletBalanceByPrivateKey(@Body() body: { privateKey: string }) {
    return this.appService.getWalletBalanceByPrivateKey(body.privateKey);
  }

  // 클라이언트용 환경변수 제공
  @Get('api/config')
  getClientConfig() {
    return {
      serverUrl: process.env.SERVER_URL || 'http://localhost:4123',
      chainId: process.env.CHAIN_ID || '11155111',
      token: process.env.TOKEN,
      rpcUrl: process.env.RPC_URL
    };
  }
}

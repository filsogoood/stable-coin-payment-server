import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // MetaMask 모바일 결제 페이지
  @Get('payment-page')
  async paymentPage(
    @Query('token') token: string,
    @Query('to') to: string,
    @Query('amount') amount: string,
    @Res() res: Response,
  ) {
    return this.appService.getPaymentPage(token, to, amount, res);
  }

  // 기존 결제 요청 (클라이언트 Authorization)
  @Post('payment')
  async payment(@Body() body: any) {
    return this.appService.payment(body);
  }

  // 새로운 서버 기반 가스리스 결제 요청
  @Post('server-payment')
  async serverPayment(@Body() body: any) {
    return this.appService.processServerPayment(body);
  }
}

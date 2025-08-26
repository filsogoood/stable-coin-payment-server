import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { AppService } from './app.service';
import type { Response } from 'express';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // QR 코드 생성 API
  @Post('create-payment-qr')
  async createPaymentQR(@Body() body: any) {
    return this.appService.createPaymentQR(body);
  }

  // nonce 조회 API
  @Post('get-nonce')
  async getNonce(@Body() body: any) {
    return this.appService.getNextNonce(body.authority, body.authorization);
  }

  // 웹 인터페이스 - QR 코드 표시 페이지
  @Get('payment-page')
  async getPaymentPage(@Query() query: any, @Res() res: Response) {
    const html = await this.appService.getPaymentPageHTML(query);
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  }

  // 유저 결제 요청
  @Post('payment')
  async payment(@Body() body: any) {
    return this.appService.payment(body);
  }
}

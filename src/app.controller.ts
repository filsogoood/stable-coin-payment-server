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
}

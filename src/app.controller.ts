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

  // QR 생성 페이지
  @Get('generate')
  getGenerate(@Res() res: Response) {
    return res.sendFile(path.join(process.cwd(), 'public', 'generate.html'));
  }

  // QR 스캔 페이지
  @Get('scan')
  getScan(@Res() res: Response) {
    return res.sendFile(path.join(process.cwd(), 'public', 'scan.html'));
  }

  // 환경변수 정보 제공 (개인키 제외)
  @Get('config')
  getConfig() {
    return this.appService.getConfig();
  }

  // 개인키 요청 (보안 엔드포인트)
  @Post('private-key')
  getPrivateKey(@Body() body: { timestamp: number }) {
    return this.appService.getPrivateKey(body.timestamp);
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

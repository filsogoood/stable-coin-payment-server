import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import * as iconv from 'iconv-lite';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';

const envPath = path.resolve(process.cwd(), '.env'); // CWD가 다르면 엉뚱한 .env 읽음
const parsed = dotenv.parse(fs.readFileSync(envPath));

// 1) 원하는 키만 화이트리스트로 강제 설정(override)
const KEYS = [
  'RPC_URL',
  'SERVER_URL',
  'PRIVATE_KEY',
  'DELEGATE_ADDRESS',
  'TOKEN',
  'TO',
  'AMOUNT_WEI',
  'CHAIN_ID',
  'SPONSOR_PK',
  'PORT',
  'ENCRYPTION_KEY',
] as const;
for (const k of KEYS) {
  const v = parsed[k as keyof typeof parsed];
  if (v != null)
    process.env[k] = v
      .replace(/^\uFEFF/, '')
      .replace(/[\r\n]+$/g, '')
      .trim();
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CORS 설정
  app.enableCors();

  // EUC-KR charset 처리 미들웨어 (Android APP 지원)
  app.use((req: any, res: any, next: any) => {
    // API 경로만 처리
    if (!req.path.startsWith('/api/')) {
      return next();
    }
    
    const contentType = req.get('Content-Type');
    
    if (contentType && contentType.toLowerCase().includes('charset=euc-kr')) {
      // EUC-KR로 인코딩된 요청 처리
      let rawData = Buffer.alloc(0);
      
      req.on('data', (chunk: Buffer) => {
        rawData = Buffer.concat([rawData, chunk]);
      });
      
      req.on('end', () => {
        try {
          // 데이터가 없으면 빈 객체로 처리
          if (rawData.length === 0) {
            req.body = {};
            return next();
          }
          
          // EUC-KR → UTF-8 변환
          const utf8String = iconv.decode(rawData, 'euc-kr').trim();
          
          // 빈 문자열 체크
          if (!utf8String) {
            req.body = {};
            return next();
          }
          
          // JSON 파싱
          req.body = JSON.parse(utf8String);
          next();
        } catch (error) {
          console.error('EUC-KR 처리 오류:', error);
          console.error('Raw data length:', rawData.length);
          console.error('Raw data:', rawData.toString('hex'));
          res.status(400).json({ error: 'Invalid request encoding or JSON format' });
        }
      });
      
      req.on('error', (error: any) => {
        console.error('요청 스트림 오류:', error);
        res.status(400).json({ error: 'Request stream error' });
      });
    } else {
      // 일반적인 UTF-8 요청은 기본 처리
      next();
    }
  });

  // 기본 JSON body parser (UTF-8용)
  app.use(json());

  // 정적 파일 서빙 설정
  app.useStaticAssets(path.join(process.cwd(), 'public'));

  await app.listen(process.env.PORT ?? 4123);
}
bootstrap();

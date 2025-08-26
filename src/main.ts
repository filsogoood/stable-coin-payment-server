import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const envPath = path.resolve(process.cwd(), '.env'); // CWD가 다르면 엉뚱한 .env 읽음
let parsed: Record<string, string> = {};
try {
  parsed = dotenv.parse(fs.readFileSync(envPath));
  console.log(`✅ 환경변수 파일 로드됨: ${envPath}`);
} catch (error) {
  console.log(`⚠️ .env 파일을 찾을 수 없음: ${envPath}`);
  console.log('기본 설정으로 실행합니다.');
}

// 1) 원하는 키만 화이트리스트로 강제 설정(override)
const KEYS = ['RPC_URL','SERVER_URL','PRIVATE_KEY','DELEGATE_ADDRESS','TOKEN','TO','AMOUNT_WEI','CHAIN_ID', 'SPONSOR_PK', 'PORT'] as const;
for (const k of KEYS) {
  const v = parsed[k as keyof typeof parsed];
  if (v != null) process.env[k] = v.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '').trim();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // CORS 설정
  app.enableCors({
    origin: ['http://localhost:4123', 'http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  });
  
  await app.listen(process.env.PORT ?? 3000);
  console.log(`Application is running on: http://localhost:${process.env.PORT ?? 3000}`);
}
bootstrap();

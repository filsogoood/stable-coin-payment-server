import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const envPath = path.resolve(process.cwd(), '.env'); // CWD가 다르면 엉뚱한 .env 읽음
const parsed = dotenv.parse(fs.readFileSync(envPath));

// 1) 원하는 키만 화이트리스트로 강제 설정(override)
const KEYS = ['RPC_URL','SERVER_URL','PRIVATE_KEY','DELEGATE_ADDRESS','TOKEN','TO','AMOUNT_WEI','CHAIN_ID', 'SPONSOR_PK'] as const;
for (const k of KEYS) {
  const v = parsed[k as keyof typeof parsed];
  if (v != null) process.env[k] = v.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '').trim();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

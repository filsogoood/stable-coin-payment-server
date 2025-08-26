import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ethers } from 'ethers';

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

// 필수 환경변수 검증 및 가스비 대납 정보 표시
function validateEnv() {
  const required = ['RPC_URL', 'SPONSOR_PK', 'DELEGATE_ADDRESS', 'CHAIN_ID'];
  const missing = required.filter(k => !process.env[k]);
  
  if (missing.length > 0) {
    console.error('❌ 필수 환경변수가 누락되었습니다:', missing.join(', '));
    process.exit(1);
  }

  // 가스비 대납 정보 표시
  console.log('🚀 가스비 대납 모드 활성화');
  console.log(`📍 네트워크: ${process.env.CHAIN_ID === '11155111' ? 'Sepolia Testnet' : `Chain ID ${process.env.CHAIN_ID}`}`);
  console.log(`💰 가스비 대납자 주소: ${new ethers.Wallet(process.env.SPONSOR_PK!).address}`);
  console.log(`📝 Delegate 컨트랙트: ${process.env.DELEGATE_ADDRESS}`);
  console.log('✅ 사용자는 가스비를 지불하지 않습니다!');
}

async function bootstrap() {
  // 환경변수 검증
  validateEnv();
  
  const app = await NestFactory.create(AppModule);
  
  // CORS 설정
  app.enableCors({
    origin: ['http://localhost:4123', 'http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  });
  
  await app.listen(Number(process.env.PORT ?? 4123));
  console.log(`🎯 서버가 포트 ${process.env.PORT ?? 4123}에서 실행 중입니다.`);
}
bootstrap();

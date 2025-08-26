import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const envPath = path.resolve(process.cwd(), '.env'); // CWD가 다르면 엉뚱한 .env 읽음
const parsed = dotenv.parse(fs.readFileSync(envPath));

// 1) 원하는 키만 화이트리스트로 강제 설정(override)
const KEYS = ['RPC_URL','SERVER_URL','PRIVATE_KEY','DELEGATE_ADDRESS','TOKEN','TO','AMOUNT_WEI','CHAIN_ID', 'SPONSOR_PK', 'PORT'] as const;
for (const k of KEYS) {
  const v = parsed[k as keyof typeof parsed];
  if (v != null) process.env[k] = v.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '').trim();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // CORS 설정 - ngrok 및 모바일 지원
  app.enableCors({
    origin: [
      'http://localhost:4123', 
      'http://127.0.0.1:4123',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      // ngrok URLs 지원 (동적으로 변경되므로 패턴 매칭)
      /^https:\/\/.*\.ngrok-free\.app$/,
      /^https:\/\/.*\.ngrok\.io$/,
      /^https:\/\/.*\.ngrok\.app$/,
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    credentials: true,
  });

  // ngrok 헤더 처리를 위한 미들웨어 추가
  app.use((req, res, next) => {
    // ngrok warning 헤더 추가
    res.header('ngrok-skip-browser-warning', 'true');
    
    // 모바일 MetaMask 지원을 위한 추가 헤더
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Preflight 요청 처리
    if (req.method === 'OPTIONS') {
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,ngrok-skip-browser-warning');
      return res.status(200).end();
    }
    
    next();
  });
  
  console.log(`🚀 서버가 포트 ${process.env.PORT ?? 3000}에서 시작되었습니다`);
  console.log(`📱 모바일 테스트용 ngrok URL 지원이 활성화되었습니다`);
  
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0'); // 모든 IP에서 접근 가능하도록 설정
}
bootstrap();

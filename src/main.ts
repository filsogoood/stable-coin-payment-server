import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import * as iconv from 'iconv-lite';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { Logger } from '@nestjs/common';

const logger = new Logger('Bootstrap');

logger.log('[BOOTSTRAP] 애플리케이션 부트스트랩 시작');
logger.log('[BOOTSTRAP] 환경변수 로딩 시작');

const envPath = path.resolve(process.cwd(), '.env'); // CWD가 다르면 엉뚱한 .env 읽음
logger.debug('[BOOTSTRAP] .env 파일 경로:', envPath);

try {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  logger.log('[BOOTSTRAP] .env 파일 로딩 성공');
  logger.debug('[BOOTSTRAP] .env 파일에서 로드된 키 개수:', Object.keys(parsed).length);

  // 1) 원하는 키만 화이트리스트로 강제 설정(override)
  logger.log('[BOOTSTRAP] 필수 환경변수 설정 시작');
  
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
  
  const loadedKeys: string[] = [];
  const missingKeys: string[] = [];
  
  for (const k of KEYS) {
    const v = parsed[k as keyof typeof parsed];
    if (v != null) {
      process.env[k] = v
        .replace(/^\uFEFF/, '')
        .replace(/[\r\n]+$/g, '')
        .trim();
      loadedKeys.push(k);
    } else {
      missingKeys.push(k);
    }
  }
  
  logger.log('[BOOTSTRAP] 환경변수 설정 완료:', {
    loaded: loadedKeys.length,
    missing: missingKeys.length,
    loadedKeys: loadedKeys.filter(k => !k.includes('KEY')), // 키 정보는 로깅에서 제외
    missingKeys
  });
  
  if (missingKeys.length > 0) {
    logger.warn('[BOOTSTRAP] 누락된 환경변수가 있습니다:', missingKeys);
  }
  
} catch (error: any) {
  logger.error('[BOOTSTRAP] .env 파일 로딩 실패:', {
    error: error.message,
    envPath
  });
  throw error;
}

async function bootstrap() {
  logger.log('[BOOTSTRAP] NestJS 애플리케이션 생성 시작');
  
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    logger.log('[BOOTSTRAP] NestJS 애플리케이션 생성 완료');

    logger.log('[BOOTSTRAP] CORS 설정 시작');
    // CORS 설정
    app.enableCors();
    logger.log('[BOOTSTRAP] CORS 설정 완료');

    logger.log('[BOOTSTRAP] EUC-KR 처리 미들웨어 설정 시작');
    
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
          logger.error('[MIDDLEWARE] EUC-KR 처리 오류:', {
            error: error.message,
            rawDataLength: rawData.length,
            rawDataHex: rawData.toString('hex'),
            path: req.path
          });
          res.status(400).json({ error: 'Invalid request encoding or JSON format' });
        }
      });
      
      req.on('error', (error: any) => {
        logger.error('[MIDDLEWARE] 요청 스트림 오류:', {
          error: error.message,
          path: req.path
        });
        res.status(400).json({ error: 'Request stream error' });
      });
    } else {
      // 일반적인 UTF-8 요청은 기본 처리
      next();
    }
  });
  
  logger.log('[BOOTSTRAP] EUC-KR 처리 미들웨어 설정 완료');

  logger.log('[BOOTSTRAP] JSON body parser 설정 시작');
  // 기본 JSON body parser (UTF-8용)
  app.use(json());
  logger.log('[BOOTSTRAP] JSON body parser 설정 완룼');

  logger.log('[BOOTSTRAP] 정적 파일 서빙 설정 시작');
  // 정적 파일 서빙 설정
  const publicPath = path.join(process.cwd(), 'public');
  app.useStaticAssets(publicPath);
  logger.log('[BOOTSTRAP] 정적 파일 서빙 설정 완룼:', publicPath);

  const port = process.env.PORT ?? 4123;
  logger.log('[BOOTSTRAP] 서버 시작 준비 완룼, 포트:', port);
  
  await app.listen(port);
  
  logger.log('[BOOTSTRAP] 서버가 성공적으로 시작되었습니다!');
  logger.log('[BOOTSTRAP] 서버 URL: http://localhost:' + port);
  logger.log('[BOOTSTRAP] API 도큰먼트: http://localhost:' + port + '/api/config');
  
  } catch (error: any) {
    logger.error('[BOOTSTRAP] 서버 시작 실패:', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

logger.log('[BOOTSTRAP] bootstrap 함수 호출 시작');
bootstrap().catch(error => {
  logger.error('[BOOTSTRAP] bootstrap 함수 실행 실패:', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

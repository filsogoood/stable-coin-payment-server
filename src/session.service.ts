// session.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';

interface PrivateKeySession {
  sessionId: string;
  privateKey: string;
  scanUrl: string;
  expiresAt: number;
  timestamp: number;
  createdAt: Date;
}

interface PaymentSession {
  sessionId: string;
  amount: string;
  recipient: string;
  token: string;
  chainId: number;
  serverUrl: string;
  rpcUrl: string;
  delegateAddress: string;
  timestamp: number;
  createdAt: Date;
}

interface CompletedSession {
  sessionId: string;
  privateKey: string;
  paymentData: PaymentSession;
  createdAt: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger('SessionService');
  
  // 메모리 기반 세션 저장소 (프로덕션에서는 Redis 등 사용 권장)
  private privateKeySessions = new Map<string, PrivateKeySession>();
  private paymentSessions = new Map<string, PaymentSession>();
  private completedSessions = new Map<string, CompletedSession>();

  constructor() {
    this.logger.log('[SESSION_SERVICE] 세션 서비스 초기화');
    // 만료된 세션 정리 (5분마다)
    setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
    this.logger.log('[SESSION_SERVICE] 자동 정리 타이머 설정 완료 (5분마다)');
  }

  // 개인키 세션 저장
  storePrivateKeySession(data: {
    sessionId: string;
    privateKey: string;
    scanUrl: string;
    expiresAt: number;
    timestamp: number;
  }): void {
    this.logger.log(`[STORE_PRIVATE_KEY] 세션 저장: ${data.sessionId}`);
    this.logger.log(`[STORE_PRIVATE_KEY] 만료 시간: ${new Date(data.expiresAt).toLocaleString()}`);
    
    this.privateKeySessions.set(data.sessionId, {
      ...data,
      createdAt: new Date()
    });

    this.logger.log(`현재 개인키 세션 수: ${this.privateKeySessions.size}`);
    this.logger.log(`저장된 세션 ID 목록: ${Array.from(this.privateKeySessions.keys()).join(', ')}`);
  }

  // 결제 세션 저장
  storePaymentSession(data: {
    sessionId: string;
    amount: string;
    recipient: string;
    token: string;
    chainId: number;
    serverUrl: string;
    rpcUrl: string;
    delegateAddress: string;
    timestamp: number;
  }): void {
    this.logger.log(`[STORE_PAYMENT] 세션 저장: ${data.sessionId}`);
    
    this.paymentSessions.set(data.sessionId, {
      ...data,
      createdAt: new Date()
    });

    this.logger.log(`현재 결제 세션 수: ${this.paymentSessions.size}`);
    this.logger.log(`저장된 결제 세션 ID 목록: ${Array.from(this.paymentSessions.keys()).join(', ')}`);
  }

  // 세션 결합 및 완전한 결제 데이터 반환
  combineSessionsForPayment(sessionId: string): CompletedSession {
    this.logger.log(`[COMBINE_SESSIONS] 세션 결합 시도: ${sessionId}`);

    const privateKeySession = this.privateKeySessions.get(sessionId);
    const paymentSession = this.paymentSessions.get(sessionId);

    if (!privateKeySession) {
      this.logger.error(`[COMBINE_SESSIONS] 개인키 세션 없음: ${sessionId}`);
      throw new BadRequestException('개인키 세션을 찾을 수 없습니다. 첫 번째 QR 코드를 다시 스캔해주세요.');
    }

    if (!paymentSession) {
      this.logger.error(`[COMBINE_SESSIONS] 결제 세션 없음: ${sessionId}`);
      throw new BadRequestException('결제 세션을 찾을 수 없습니다. 두 번째 QR 코드를 다시 스캔해주세요.');
    }

    // 만료 시간 확인
    if (privateKeySession.expiresAt < Date.now()) {
      this.logger.error(`[COMBINE_SESSIONS] 세션 만료: ${sessionId}`);
      this.cleanupSession(sessionId);
      throw new BadRequestException('세션이 만료되었습니다. 새로운 QR 코드를 생성해주세요.');
    }

    // 완성된 세션 생성
    const completedSession: CompletedSession = {
      sessionId,
      privateKey: privateKeySession.privateKey,
      paymentData: paymentSession,
      createdAt: new Date()
    };

    // 완성된 세션 저장
    this.completedSessions.set(sessionId, completedSession);
    
    this.logger.log(`[COMBINE_SESSIONS] 세션 결합 성공: ${sessionId}`);
    
    return completedSession;
  }

  // 개인키 세션 존재 확인
  hasPrivateKeySession(sessionId: string): boolean {
    const exists = this.privateKeySessions.has(sessionId);
    this.logger.log(`[CHECK_PRIVATE_KEY] 세션 ${sessionId}: ${exists ? '존재' : '없음'}`);
    
    if (!exists) {
      this.logger.log(`[CHECK_PRIVATE_KEY] 현재 저장된 개인키 세션들: ${Array.from(this.privateKeySessions.keys()).join(', ')}`);
    }
    
    return exists;
  }

  // 결제 세션 존재 확인
  hasPaymentSession(sessionId: string): boolean {
    const exists = this.paymentSessions.has(sessionId);
    this.logger.log(`[CHECK_PAYMENT] 세션 ${sessionId}: ${exists ? '존재' : '없음'}`);
    
    if (!exists) {
      this.logger.log(`[CHECK_PAYMENT] 현재 저장된 결제 세션들: ${Array.from(this.paymentSessions.keys()).join(', ')}`);
    }
    
    return exists;
  }

  // 특정 세션 정리
  cleanupSession(sessionId: string): void {
    this.logger.debug(`[CLEANUP] 세션 정리: ${sessionId}`);
    
    this.privateKeySessions.delete(sessionId);
    this.paymentSessions.delete(sessionId);
    this.completedSessions.delete(sessionId);
  }

  // 만료된 세션 정리
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    this.logger.log(`[CLEANUP] 세션 정리 시작. 현재 시간: ${new Date(now).toLocaleString()}`);

    // 개인키 세션 정리
    const expiredPrivateKeys: string[] = [];
    for (const [sessionId, session] of this.privateKeySessions.entries()) {
      if (session.expiresAt < now) {
        this.privateKeySessions.delete(sessionId);
        expiredPrivateKeys.push(sessionId);
        cleanedCount++;
      }
    }
    if (expiredPrivateKeys.length > 0) {
      this.logger.log(`[CLEANUP] 만료된 개인키 세션들: ${expiredPrivateKeys.join(', ')}`);
    }

    // 결제 세션 정리 (10분 초과된 것들)
    const paymentExpireTime = 10 * 60 * 1000; // 10분
    const expiredPayments: string[] = [];
    for (const [sessionId, session] of this.paymentSessions.entries()) {
      if (now - session.createdAt.getTime() > paymentExpireTime) {
        this.paymentSessions.delete(sessionId);
        expiredPayments.push(sessionId);
        cleanedCount++;
      }
    }
    if (expiredPayments.length > 0) {
      this.logger.log(`[CLEANUP] 만료된 결제 세션들: ${expiredPayments.join(', ')}`);
    }

    // 완성된 세션 정리 (30분 초과된 것들)
    const completedExpireTime = 30 * 60 * 1000; // 30분
    const expiredCompleted: string[] = [];
    for (const [sessionId, session] of this.completedSessions.entries()) {
      if (now - session.createdAt.getTime() > completedExpireTime) {
        this.completedSessions.delete(sessionId);
        expiredCompleted.push(sessionId);
        cleanedCount++;
      }
    }
    if (expiredCompleted.length > 0) {
      this.logger.log(`[CLEANUP] 만료된 완성 세션들: ${expiredCompleted.join(', ')}`);
    }

    if (cleanedCount > 0) {
      this.logger.log(`[CLEANUP] 만료된 세션 ${cleanedCount}개 정리됨`);
    } else {
      this.logger.log(`[CLEANUP] 정리할 만료된 세션 없음`);
    }
  }

  // 세션 상태 조회 (디버깅용)
  getSessionStats(): any {
    return {
      privateKeySessions: this.privateKeySessions.size,
      paymentSessions: this.paymentSessions.size,
      completedSessions: this.completedSessions.size,
      timestamp: new Date().toISOString()
    };
  }

  // 모든 세션 정보 조회 (디버깅용)
  getAllSessionsForDebug(): any {
    const privateKeysInfo = Array.from(this.privateKeySessions.entries()).map(([id, session]) => ({
      sessionId: id,
      expiresAt: new Date(session.expiresAt).toLocaleString(),
      createdAt: session.createdAt.toLocaleString(),
      expired: session.expiresAt < Date.now()
    }));

    const paymentInfo = Array.from(this.paymentSessions.entries()).map(([id, session]) => ({
      sessionId: id,
      amount: session.amount,
      recipient: session.recipient.substring(0, 10) + '...',
      createdAt: session.createdAt.toLocaleString()
    }));

    return {
      privateKeySessions: privateKeysInfo,
      paymentSessions: paymentInfo,
      completedSessions: this.completedSessions.size,
      timestamp: new Date().toISOString()
    };
  }
}
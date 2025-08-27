import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface EncryptedPaymentData {
  type: 'encrypted_payment';
  encryptedData: string;
  iv: string;
  timestamp: number;
}

export interface EncryptedPrivateKeyData {
  type: 'encrypted_private_key';
  sessionId: string;
  encryptedData: string;
  iv: string;
  timestamp: number;
}

export interface EncryptedPaymentOnlyData {
  type: 'encrypted_payment_only';
  sessionId: string;
  encryptedData: string;
  iv: string;
  timestamp: number;
}

export interface PaymentData {
  privateKey: string;
  amount: string;
  recipient: string;
  token: string;
  chainId: number;
  serverUrl: string;
  rpcUrl: string;
  delegateAddress: string;
  timestamp: number;
}

export interface PrivateKeyData {
  privateKey: string;
  sessionId: string;
  timestamp: number;
}

export interface PaymentOnlyData {
  amount: string;
  recipient: string;
  token: string;
  chainId: number;
  serverUrl: string;
  rpcUrl: string;
  delegateAddress: string;
  sessionId: string;
  timestamp: number;
}

@Injectable()
export class CryptoService {
  private readonly logger = new Logger('CryptoService');
  
  // 서버에서 관리하는 고정 암호화 키 (실제 운영에서는 환경변수로 관리)
  private readonly ENCRYPTION_KEY: string;
  private readonly ALGORITHM = 'aes-256-cbc';

  // 2단계 QR을 위한 임시 저장소 (개인키 정보)
  private privateKeyStorage = new Map<string, PrivateKeyData>();

  constructor() {
    // 환경변수 존재 여부 확인
    if (!process.env.ENCRYPTION_KEY) {
      this.logger.error('[CRYPTO_SERVICE] ENCRYPTION_KEY 환경변수가 설정되지 않았습니다.');
      throw new Error('ENCRYPTION_KEY 환경변수가 필요합니다.');
    }

    this.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

    // 키 정보 로깅
    this.logger.log(`[CRYPTO_SERVICE] 환경변수에서 읽어온 키: "${this.ENCRYPTION_KEY}"`);
    this.logger.log(`[CRYPTO_SERVICE] 키 길이: ${this.ENCRYPTION_KEY.length}자`);
    this.logger.log(`[CRYPTO_SERVICE] 키 바이트 길이: ${Buffer.from(this.ENCRYPTION_KEY).length}바이트`);
    
    // 키 길이 검증 (32바이트 = 256비트)
    if (this.ENCRYPTION_KEY.length !== 32) {
      this.logger.error(`[CRYPTO_SERVICE] 키 길이 오류: 예상 32자, 실제 ${this.ENCRYPTION_KEY.length}자`);
      throw new Error('암호화 키는 정확히 32자여야 합니다.');
    }
    
    this.logger.log('[CRYPTO_SERVICE] 암호화 서비스 초기화 완료');
  }

  /**
   * 결제 데이터 암호화
   */
  encryptPaymentData(paymentData: PaymentData): EncryptedPaymentData {
    try {
      // JSON 문자열로 변환
      const dataString = JSON.stringify(paymentData);
      
      // 랜덤 IV 생성
      const iv = crypto.randomBytes(16);
      
      // 암호화 (올바른 방식)
      const cipher = crypto.createCipheriv(this.ALGORITHM, Buffer.from(this.ENCRYPTION_KEY), iv);
      
      let encrypted = cipher.update(dataString, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const result: EncryptedPaymentData = {
        type: 'encrypted_payment',
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        timestamp: Date.now()
      };

      this.logger.log(`[ENCRYPT] 결제 데이터 암호화 완료, 크기: ${encrypted.length}바이트`);
      
      return result;
    } catch (error) {
      this.logger.error(`[ENCRYPT] 암호화 실패: ${error.message}`);
      throw new Error('결제 데이터 암호화에 실패했습니다.');
    }
  }

  /**
   * 결제 데이터 복호화
   */
  decryptPaymentData(encryptedPayment: EncryptedPaymentData): PaymentData {
    try {
      // 타입 검증
      if (encryptedPayment.type !== 'encrypted_payment') {
        throw new Error('잘못된 암호화 데이터 타입입니다.');
      }

      // 타임스탬프는 로깅 목적으로만 사용 (유효기간 체크 없음)

      // IV 복원
      const iv = Buffer.from(encryptedPayment.iv, 'hex');
      
      // 복호화 (CryptoJS 호환)
      const decipher = crypto.createDecipheriv(this.ALGORITHM, Buffer.from(this.ENCRYPTION_KEY), iv);
      
      // CryptoJS는 Base64로 인코딩하므로 'base64'로 디코딩
      let decrypted = decipher.update(encryptedPayment.encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      
      // JSON 파싱
      const paymentData: PaymentData = JSON.parse(decrypted);
      
      // 필수 필드 검증
      const requiredFields = ['privateKey', 'amount', 'recipient', 'token', 'chainId', 'serverUrl', 'rpcUrl', 'delegateAddress'];
      for (const field of requiredFields) {
        if (!paymentData[field]) {
          throw new Error(`필수 필드 ${field}가 없습니다.`);
        }
      }

      this.logger.log(`[DECRYPT] 결제 데이터 복호화 완료`);
      
      return paymentData;
    } catch (error) {
      this.logger.error(`[DECRYPT] 복호화 실패: ${error.message}`);
      throw new Error('암호화된 결제 데이터 복호화에 실패했습니다: ' + error.message);
    }
  }

  /**
   * 주소 단축 표시용
   */
  shortenAddress(address: string): string {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  /**
   * 암호화 상태 체크 (디버깅용)
   */
  getEncryptionInfo(): any {
    return {
      algorithm: this.ALGORITHM,
      keyLength: this.ENCRYPTION_KEY.length,
      keyConfigured: !!this.ENCRYPTION_KEY,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 2단계 QR: 개인키만 암호화
   */
  encryptPrivateKey(privateKey: string, sessionId: string): EncryptedPrivateKeyData {
    try {
      const privateKeyData: PrivateKeyData = {
        privateKey,
        sessionId,
        timestamp: Date.now()
      };

      const dataString = JSON.stringify(privateKeyData);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.ALGORITHM, Buffer.from(this.ENCRYPTION_KEY), iv);
      
      let encrypted = cipher.update(dataString, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const result: EncryptedPrivateKeyData = {
        type: 'encrypted_private_key',
        sessionId,
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        timestamp: Date.now()
      };

      this.logger.log(`[ENCRYPT_PRIVATE_KEY] 개인키 암호화 완료: ${sessionId}`);
      return result;
    } catch (error) {
      this.logger.error(`[ENCRYPT_PRIVATE_KEY] 암호화 실패: ${error.message}`);
      throw new Error('개인키 암호화에 실패했습니다.');
    }
  }

  /**
   * 2단계 QR: 결제정보만 암호화 (개인키 제외)
   */
  encryptPaymentOnly(paymentOnlyData: PaymentOnlyData): EncryptedPaymentOnlyData {
    try {
      const dataString = JSON.stringify(paymentOnlyData);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.ALGORITHM, Buffer.from(this.ENCRYPTION_KEY), iv);
      
      let encrypted = cipher.update(dataString, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const result: EncryptedPaymentOnlyData = {
        type: 'encrypted_payment_only',
        sessionId: paymentOnlyData.sessionId,
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        timestamp: Date.now()
      };

      this.logger.log(`[ENCRYPT_PAYMENT_ONLY] 결제정보 암호화 완료: ${paymentOnlyData.sessionId}`);
      return result;
    } catch (error) {
      this.logger.error(`[ENCRYPT_PAYMENT_ONLY] 암호화 실패: ${error.message}`);
      throw new Error('결제정보 암호화에 실패했습니다.');
    }
  }

  /**
   * 개인키 복호화 및 저장
   */
  decryptAndStorePrivateKey(encryptedPrivateKey: EncryptedPrivateKeyData): { sessionId: string; success: boolean } {
    try {
      if (encryptedPrivateKey.type !== 'encrypted_private_key') {
        throw new Error('잘못된 개인키 데이터 타입입니다.');
      }

      const iv = Buffer.from(encryptedPrivateKey.iv, 'hex');
      const decipher = crypto.createDecipheriv(this.ALGORITHM, Buffer.from(this.ENCRYPTION_KEY), iv);
      
      // CryptoJS는 Base64로 인코딩하므로 'base64'로 디코딩
      let decrypted = decipher.update(encryptedPrivateKey.encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      
      const privateKeyData: PrivateKeyData = JSON.parse(decrypted);

      // 임시 저장소에 저장
      this.privateKeyStorage.set(privateKeyData.sessionId, privateKeyData);

      this.logger.log(`[DECRYPT_PRIVATE_KEY] 개인키 복호화 및 저장 완료: ${privateKeyData.sessionId}`);
      
      return { sessionId: privateKeyData.sessionId, success: true };
    } catch (error) {
      this.logger.error(`[DECRYPT_PRIVATE_KEY] 복호화 실패: ${error.message}`);
      throw new Error('개인키 복호화에 실패했습니다: ' + error.message);
    }
  }

  /**
   * 결제정보 복호화 및 완전한 결제 데이터 생성
   */
  decryptPaymentOnlyAndCombine(encryptedPaymentOnly: EncryptedPaymentOnlyData): PaymentData {
    try {
      if (encryptedPaymentOnly.type !== 'encrypted_payment_only') {
        throw new Error('잘못된 결제정보 데이터 타입입니다.');
      }

      // 저장된 개인키 조회
      const privateKeyData = this.privateKeyStorage.get(encryptedPaymentOnly.sessionId);
      if (!privateKeyData) {
        throw new Error('개인키 정보를 찾을 수 없습니다. 첫 번째 QR 코드를 먼저 스캔해주세요.');
      }

      // 결제정보 복호화
      const iv = Buffer.from(encryptedPaymentOnly.iv, 'hex');
      const decipher = crypto.createDecipheriv(this.ALGORITHM, Buffer.from(this.ENCRYPTION_KEY), iv);
      
      // CryptoJS는 Base64로 인코딩하므로 'base64'로 디코딩
      let decrypted = decipher.update(encryptedPaymentOnly.encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      
      const paymentOnlyData: PaymentOnlyData = JSON.parse(decrypted);

      // 세션 ID 일치 확인
      if (paymentOnlyData.sessionId !== privateKeyData.sessionId) {
        throw new Error('세션 ID가 일치하지 않습니다.');
      }

      // 완전한 결제 데이터 생성
      const completePaymentData: PaymentData = {
        privateKey: privateKeyData.privateKey,
        amount: paymentOnlyData.amount,
        recipient: paymentOnlyData.recipient,
        token: paymentOnlyData.token,
        chainId: paymentOnlyData.chainId,
        serverUrl: paymentOnlyData.serverUrl,
        rpcUrl: paymentOnlyData.rpcUrl,
        delegateAddress: paymentOnlyData.delegateAddress,
        timestamp: paymentOnlyData.timestamp
      };

      // 사용된 개인키 정보 삭제
      this.privateKeyStorage.delete(encryptedPaymentOnly.sessionId);

      this.logger.log(`[DECRYPT_PAYMENT_COMBINE] 결제정보 복호화 및 결합 완료: ${encryptedPaymentOnly.sessionId}`);
      
      return completePaymentData;
    } catch (error) {
      this.logger.error(`[DECRYPT_PAYMENT_COMBINE] 복호화 실패: ${error.message}`);
      throw new Error('결제정보 복호화에 실패했습니다: ' + error.message);
    }
  }

  /**
   * 개인키 데이터 수동 정리 (시간 제한 없음, 수동 호출용)
   */
  private cleanupAllPrivateKeys(): void {
    const cleanedCount = this.privateKeyStorage.size;
    this.privateKeyStorage.clear();

    if (cleanedCount > 0) {
      this.logger.log(`[MANUAL_CLEANUP] 개인키 데이터 ${cleanedCount}개 수동 정리됨`);
    }
  }

  /**
   * 저장된 개인키 상태 확인 (디버깅용)
   */
  getStoredPrivateKeyStats(): any {
    return {
      storedCount: this.privateKeyStorage.size,
      sessionIds: Array.from(this.privateKeyStorage.keys()),
      timestamp: new Date().toISOString()
    };
  }
}

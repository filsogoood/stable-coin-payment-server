import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';

export interface PaymentRequest {
  to: string;
  amount: string;
  token?: string;
  memo?: string;
  chainId?: number; // 체인 ID 추가
  autoExecute?: boolean; // 자동 실행 옵션 추가
}

@Injectable()
export class QrService {
  // 기본 체인 ID (Sepolia)
  private readonly DEFAULT_CHAIN_ID = 11155111;

  /**
   * 결제 요청 QR 코드 생성 (자동 실행 URL 또는 EIP-681 표준)
   */
  async generatePaymentQR(paymentRequest: PaymentRequest): Promise<string> {
    try {
      let qrContent: string;
      
      // 자동 실행 옵션이 활성화된 경우 웹 URL 생성
      if (paymentRequest.autoExecute) {
        qrContent = this.generateExecutionURL(paymentRequest);
      } else {
        // 기존 EIP-681 형태의 URI 생성
        qrContent = this.generateEthereumURI(paymentRequest);
      }

      // QR 코드 생성 (Base64 형태로 반환)
      const qrCode = await QRCode.toDataURL(qrContent, {
        errorCorrectionLevel: 'M',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      });

      return qrCode;
    } catch (error) {
      throw new Error(`QR 코드 생성 실패: ${error.message}`);
    }
  }

  /**
   * 결제 요청 URI 텍스트 생성 (디버깅용)
   */
  async generatePaymentURI(paymentRequest: PaymentRequest): Promise<string> {
    return this.generateEthereumURI(paymentRequest);
  }

  /**
   * 간단한 지갑 주소 QR 코드 생성 (EIP-681 표준)
   */
  async generateWalletAddressQR(address: string, chainId?: number): Promise<string> {
    try {
      // 체인 ID 포함한 지갑 주소 생성
      const chain = chainId || this.DEFAULT_CHAIN_ID;
      const ethereumUri = `ethereum:${address}@${chain}`;
      
      const qrCode = await QRCode.toDataURL(ethereumUri, {
        errorCorrectionLevel: 'M',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      });

      return qrCode;
    } catch (error) {
      throw new Error(`지갑 주소 QR 코드 생성 실패: ${error.message}`);
    }
  }

  /**
   * EIP-681 형태의 이더리움 URI 생성
   * 형식: ethereum:주소@체인ID?파라미터
   */
  private generateEthereumURI(paymentRequest: PaymentRequest): string {
    const chainId = paymentRequest.chainId || this.DEFAULT_CHAIN_ID;
    
    if (!paymentRequest.token || paymentRequest.token === 'ETH') {
      // ETH 네이티브 토큰 결제
      // 형식: ethereum:받는주소@체인ID?value=wei값
      const weiAmount = this.ethToWei(paymentRequest.amount);
      return `ethereum:${paymentRequest.to}@${chainId}?value=${weiAmount}`;
    } else {
      // ERC-20 토큰 결제
      // 형식: ethereum:토큰주소@체인ID/transfer?address=받는주소&uint256=토큰량
      const tokenAmount = this.tokenToWei(paymentRequest.amount, 18); // 기본 18 decimals 사용
      
      // MetaMask가 더 잘 인식하는 형식으로 변경
      // 토큰 컨트랙트 주소를 먼저, 그 다음 transfer 함수 호출
      return `ethereum:${paymentRequest.token}@${chainId}/transfer?address=${paymentRequest.to}&uint256=${tokenAmount}`;
    }
  }

  /**
   * 자동 실행 웹 URL 생성
   * QR 코드 스캔 시 자동으로 결제가 실행되는 웹 페이지로 이동
   */
  private generateExecutionURL(paymentRequest: PaymentRequest): string {
    const baseUrl = process.env.SERVER_URL || 'http://localhost:4123';
    const params = new URLSearchParams();
    
    params.append('to', paymentRequest.to);
    params.append('amount', paymentRequest.amount);
    
    if (paymentRequest.token) {
      params.append('token', paymentRequest.token);
    }
    
    if (paymentRequest.chainId) {
      params.append('chainId', paymentRequest.chainId.toString());
    }
    
    if (paymentRequest.memo) {
      params.append('memo', paymentRequest.memo);
    }
    
    return `${baseUrl}/qr/execute?${params.toString()}`;
  }

  /**
   * ETH를 Wei로 변환
   */
  private ethToWei(ethAmount: string): string {
    const eth = parseFloat(ethAmount);
    const wei = BigInt(Math.floor(eth * 1e18));
    return wei.toString();
  }

  /**
   * 토큰 금액을 Wei 단위로 변환 (decimals 고려)
   */
  private tokenToWei(amount: string, decimals: number = 18): string {
    const tokenAmount = parseFloat(amount);
    const wei = BigInt(Math.floor(tokenAmount * Math.pow(10, decimals)));
    return wei.toString();
  }
} 
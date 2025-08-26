import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';

export interface PaymentRequest {
  to: string;
  amount: string;
  token?: string;
  memo?: string;
}

@Injectable()
export class QrService {
  /**
   * 결제 요청 QR 코드 생성 (EIP-681 표준)
   */
  async generatePaymentQR(paymentRequest: PaymentRequest): Promise<string> {
    try {
      // EIP-681 형태의 URI 생성
      const ethereumUri = this.generateEthereumURI(paymentRequest);

      // QR 코드 생성 (Base64 형태로 반환)
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
  async generateWalletAddressQR(address: string): Promise<string> {
    try {
      // 단순 지갑 주소는 ethereum: 접두사를 붙여서 생성
      const ethereumUri = `ethereum:${address}`;
      
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
   */
  private generateEthereumURI(paymentRequest: PaymentRequest): string {
    if (!paymentRequest.token || paymentRequest.token === 'ETH') {
      // ETH 네이티브 토큰 결제
      const weiAmount = this.ethToWei(paymentRequest.amount);
      return `ethereum:${paymentRequest.to}?value=${weiAmount}`;
    } else {
      // ERC-20 토큰 결제
      const tokenAmount = this.tokenToWei(paymentRequest.amount, 18); // 기본 18 decimals 사용
      return `ethereum:${paymentRequest.token}/transfer?address=${paymentRequest.to}&uint256=${tokenAmount}`;
    }
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
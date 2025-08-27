// QR 생성 페이지 JavaScript

class QRGenerator {
    constructor() {
        this.envConfig = null;
        this.init();
    }

    async init() {
        // QRCode 라이브러리가 로드될 때까지 대기
        await this.waitForQRCode();
        this.bindEvents();
        await this.loadEnvConfig();
    }

    async waitForQRCode() {
        return new Promise((resolve) => {
            if (typeof QRCode !== 'undefined') {
                resolve();
                return;
            }
            
            const checkQRCode = () => {
                if (typeof QRCode !== 'undefined') {
                    resolve();
                } else {
                    setTimeout(checkQRCode, 100);
                }
            };
            
            checkQRCode();
        });
    }

    bindEvents() {
        document.getElementById('generateBtn').addEventListener('click', () => this.generateQR());
    }

    async loadEnvConfig() {
        try {
            const response = await fetch('/config');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            this.envConfig = await response.json();
            
            // 폼 필드에 기본값 설정
            if (this.envConfig.amountWei) {
                document.getElementById('amount').placeholder = `기본값: ${this.envConfig.amountWei}`;
            }
            if (this.envConfig.to) {
                document.getElementById('recipient').placeholder = `기본값: ${this.envConfig.to}`;
            }
            if (this.envConfig.token) {
                document.getElementById('token').placeholder = `기본값: ${this.envConfig.token}`;
            }
            
            this.showStatus('환경변수가 성공적으로 로드되었습니다.', 'success');
        } catch (error) {
            console.error('환경변수 로드 실패:', error);
            this.showStatus('환경변수 로드 실패: ' + error.message, 'error');
        }
    }

    async generateQR() {
        try {
            this.setLoading(true);
            
            // 입력값 수집
            const paymentData = this.collectPaymentData();
            
            // QR 데이터 생성
            const qrData = JSON.stringify(paymentData);
            
            // QR 코드 생성
            await this.createQRCode(qrData);
            
            // QR 정보 표시
            this.displayQRInfo(paymentData);
            
            this.showStatus('QR 코드가 성공적으로 생성되었습니다!', 'success');
            
        } catch (error) {
            console.error('QR 생성 실패:', error);
            this.showStatus('QR 생성 실패: ' + error.message, 'error');
        } finally {
            this.setLoading(false);
        }
    }

    collectPaymentData() {
        if (!this.envConfig) {
            throw new Error('환경변수가 로드되지 않았습니다. 페이지를 새로고침해주세요.');
        }

        if (!this.envConfig.hasPrivateKey) {
            throw new Error('서버에 개인키가 설정되지 않았습니다.');
        }

        const amount = document.getElementById('amount').value || this.envConfig.amountWei;
        const recipient = document.getElementById('recipient').value || this.envConfig.to;
        const token = document.getElementById('token').value || this.envConfig.token;

        // 필수 값 검증
        if (!amount || !recipient || !token) {
            throw new Error('금액, 받는 주소, 토큰 주소는 필수입니다.');
        }

        return {
            amount,
            recipient,
            token,
            // 개인키는 QR에 포함하지 않고, 특별한 식별자만 포함
            privateKeyRequired: true,
            serverUrl: this.envConfig.serverUrl,
            rpcUrl: this.envConfig.rpcUrl,
            delegateAddress: this.envConfig.delegateAddress,
            chainId: this.envConfig.chainId,
            timestamp: Date.now()
        };
    }

    async createQRCode(data) {
        // QRCode 라이브러리가 사용 가능한지 확인
        if (typeof QRCode === 'undefined') {
            throw new Error('QRCode 라이브러리가 로드되지 않았습니다. 페이지를 새로고침해주세요.');
        }

        const qrDisplay = document.getElementById('qrDisplay');
        qrDisplay.innerHTML = '';

        // QR 코드 생성 옵션
        const options = {
            width: 300,
            height: 300,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        };

        // 캔버스에 QR 코드 생성
        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, data, options);
        qrDisplay.appendChild(canvas);

        // 다운로드 링크 추가
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn btn-secondary mt-2';
        downloadBtn.textContent = 'QR 코드 다운로드';
        downloadBtn.onclick = () => this.downloadQR(canvas);
        qrDisplay.appendChild(downloadBtn);
    }

    downloadQR(canvas) {
        const link = document.createElement('a');
        link.download = `payment-qr-${Date.now()}.png`;
        link.href = canvas.toDataURL();
        link.click();
    }

    displayQRInfo(data) {
        const qrInfo = document.getElementById('qrInfo');
        const qrContent = document.getElementById('qrContent');

        const infoHtml = `
            <div class="status info">
                <strong>💰 금액:</strong> ${data.amount} WEI<br>
                <strong>📧 받는 주소:</strong> ${this.shortenAddress(data.recipient)}<br>
                <strong>🪙 토큰:</strong> ${this.shortenAddress(data.token)}<br>
                <strong>🔗 체인 ID:</strong> ${data.chainId}<br>
                <strong>🔐 개인키 필요:</strong> ${data.privateKeyRequired ? '예 (서버에서 제공)' : '아니오'}<br>
                <strong>⏰ 생성 시간:</strong> ${new Date(data.timestamp).toLocaleString()}
            </div>
            <div class="status warning mt-2">
                <strong>⚠️ 보안 주의:</strong> 이 QR 코드는 서버의 개인키를 사용한 결제를 요청합니다. 
                안전한 환경에서만 스캔하고, QR 코드 생성 후 10분 이내에만 유효합니다.
            </div>
        `;

        qrContent.innerHTML = infoHtml;
        qrInfo.classList.remove('hidden');
    }

    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    setLoading(loading) {
        const btn = document.getElementById('generateBtn');
        const text = document.getElementById('generateText');
        const loadingEl = document.getElementById('generateLoading');

        btn.disabled = loading;
        text.classList.toggle('hidden', loading);
        loadingEl.classList.toggle('hidden', !loading);
    }

    showStatus(message, type) {
        const statusEl = document.getElementById('status');
        statusEl.className = `status ${type}`;
        statusEl.textContent = message;
        statusEl.classList.remove('hidden');

        // 3초 후 자동 숨김 (성공 메시지만)
        if (type === 'success') {
            setTimeout(() => {
                statusEl.classList.add('hidden');
            }, 3000);
        }
    }
}

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', () => {
    new QRGenerator();
});

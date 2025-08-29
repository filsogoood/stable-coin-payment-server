// QR 스캔 및 2단계 결제 처리 JavaScript

class DualQRPaymentScanner {
    constructor() {
        this.scanner = null;
        this.currentStep = 1; // 1: 개인키 QR, 2: 결제정보 QR
        this.sessionId = null;
        this.privateKeyData = null;
        this.paymentData = null;
        this.debugLogs = [];
        this.scanAttempts = 0;
        this.isScanning = false;
        this.lastScanTime = null;
        this.pauseScanning = false;
        this.init();
    }

    async init() {
        this.bindEvents();
        this.initializeEthers();
        this.updateStepIndicator();
    }

    bindEvents() {
        document.getElementById('startScanBtn').addEventListener('click', () => this.startScanner());
        document.getElementById('stopScanBtn').addEventListener('click', () => this.stopScanner());
        document.getElementById('newScanBtn').addEventListener('click', () => this.resetScanner());
        
        // 모바일 터치 이벤트 지원
        this.bindMobileTouchEvents();
        
        // 페이지 가시성 변경 이벤트 (성능 최적화)
        document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    }

    updateStepIndicator() {
        // 단계별 UI 업데이트
        const stepTitle = document.getElementById('stepTitle');
        const stepDescription = document.getElementById('stepDescription');
        
        if (this.currentStep === 1) {
            stepTitle.innerHTML = '1. 개인키 QR 코드 스캔';
            stepDescription.innerHTML = '빨간색 개인키 QR 코드를 먼저 스캔해주세요';
            document.querySelector('.scan-frame').style.borderColor = '#dc2626'; // 빨간색
        } else if (this.currentStep === 2) {
            stepTitle.innerHTML = '2. 결제정보 QR 코드 스캔';
            stepDescription.innerHTML = '초록색 결제정보 QR 코드를 스캔해주세요';
            document.querySelector('.scan-frame').style.borderColor = '#16a34a'; // 초록색
        } else {
            stepTitle.innerHTML = '스캔 완료';
            stepDescription.innerHTML = '결제 처리가 완료되었습니다';
            document.querySelector('.scan-frame').style.borderColor = '#6b7280'; // 회색
        }
    }

    initializeEthers() {
        // 라이브러리 로드 상태 확인
        this.addDebugLog('라이브러리 로드 상태 확인 시작');
        
        const qrScannerStatus = typeof QrScanner !== 'undefined';
        const ethersStatus = typeof ethers !== 'undefined';
        
        this.addDebugLog(`- QrScanner: ${qrScannerStatus ? '로드됨' : '로드 실패'}`);
        this.addDebugLog(`- ethers: ${ethersStatus ? '로드됨' : '로드 실패'}`);
        
        if (!qrScannerStatus) {
            this.addDebugLog('QR 스캐너 라이브러리 로드 실패');
            this.showStatus('QR 스캐너 라이브러리 로드 실패', 'error');
            return;
        }
        
        if (!ethersStatus) {
            this.addDebugLog('Ethers.js 라이브러리 로드 실패');
            this.showStatus('Ethers.js 라이브러리 로드 실패', 'error');
            return;
        }
        
        this.addDebugLog('모든 라이브러리 로드 완료');
        this.showStatus('라이브러리 로드 완료. QR 스캔을 시작할 수 있습니다.', 'info');
    }

    async startScanner() {
        try {
            this.addDebugLog(`QR 스캐너 시작 중... (단계: ${this.currentStep})`);
            
            // 모바일 기기 감지
            const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            this.addDebugLog(`모바일 기기 감지: ${isMobile}`);
            
            // 기본 지원 확인
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('카메라가 지원되지 않는 브라우저입니다.');
            }
            
            // QrScanner 라이브러리 확인
            if (typeof QrScanner === 'undefined') {
                throw new Error('QR 스캐너 라이브러리가 로드되지 않았습니다.');
            }
            
            this.addDebugLog('카메라 및 라이브러리 지원 확인됨');

            const video = document.getElementById('scanner-video');
            
            // 비디오 엘리먼트 확인
            if (!video) {
                throw new Error('비디오 엘리먼트를 찾을 수 없습니다.');
            }
            
            this.addDebugLog('비디오 엘리먼트 확인됨');
            
            // 명시적 카메라 권한 요청
            this.addDebugLog('카메라 권한 요청 중...');
            try {
                const constraints = {
                    video: {
                        facingMode: 'environment',
                        width: { 
                            min: 640,
                            ideal: isMobile ? 1080 : 1280,
                            max: 1920
                        },
                        height: { 
                            min: 480,
                            ideal: isMobile ? 720 : 720,
                            max: 1080
                        },
                        frameRate: {
                            min: 15,
                            ideal: isMobile ? 25 : 30,
                            max: 30
                        },
                        aspectRatio: isMobile ? { ideal: 4/3 } : { ideal: 16/9 }
                    }
                };
                
                this.addDebugLog(`카메라 제약 조건: ${JSON.stringify(constraints.video)}`);
                
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                stream.getTracks().forEach(track => track.stop());
                this.addDebugLog('카메라 권한 확인 성공');
            } catch (permError) {
                this.addDebugLog(`카메라 권한 거부: ${permError.message}`);
                throw new Error('카메라 권한이 필요합니다. 브라우저 설정에서 카메라 접근을 허용해주세요.');
            }
            
            // QR 스캐너 초기화
            this.scanner = new QrScanner(
                video,
                result => {
                    this.addDebugLog(`QR 코드 스캔 성공: ${result.data || result}`);
                    this.showQRDetectedFeedback();
                    this.handleQRResult(result.data || result);
                },
                {
                    returnDetailedScanResult: true,
                    
                    onDecodeError: error => {
                        if (this.pauseScanning) return;
                        
                        this.scanAttempts++;
                        this.lastScanTime = new Date().toLocaleTimeString();
                        
                        if (this.scanAttempts % 5 === 0) {
                            this.updateScanningStatus();
                        }
                        
                        if (this.scanAttempts % 50 === 0) {
                            this.addDebugLog(`${this.scanAttempts}회 시도 후도 QR 코드 비인식. 카메라 상태 확인 필요`);
                        }
                        
                        if (error && !error.toString().includes('No QR code found')) {
                            this.addDebugLog(`QR 스캔 오류: ${error}`);
                            
                            if (error.toString().includes('NetworkError') || 
                                error.toString().includes('NotReadableError')) {
                                this.addDebugLog('카메라 오류 감지, 스캔 중단 고려');
                                this.showStatus('카메라 오류가 발생했습니다. 다시 시도해주세요.', 'error');
                            }
                        }
                    },
                    
                    highlightScanRegion: true,
                    highlightCodeOutline: true,
                    preferredCamera: 'environment',
                    maxScansPerSecond: isMobile ? 8 : 15,
                    
                    calculateScanRegion: (video) => {
                        const width = video.videoWidth;
                        const height = video.videoHeight;
                        const minDimension = Math.min(width, height);
                        
                        const scanRatio = isMobile ? 0.85 : 0.75;
                        const scanSize = Math.floor(minDimension * scanRatio);
                        
                        const downscaleRatio = isMobile ? 0.8 : 1.0;
                        const downScaledWidth = Math.floor(scanSize * downscaleRatio);
                        const downScaledHeight = Math.floor(scanSize * downscaleRatio);
                        
                        const region = {
                            x: Math.floor((width - scanSize) / 2),
                            y: Math.floor((height - scanSize) / 2),
                            width: scanSize,
                            height: scanSize,
                            downScaledWidth: downScaledWidth,
                            downScaledHeight: downScaledHeight
                        };
                        
                        return region;
                    }
                }
            );
            
            this.addDebugLog('QR 스캐너 인스턴스 생성됨');

            // 카메라 시작
            this.addDebugLog('카메라 시작 중...');
            
            try {
                await this.scanner.start();
                
                const hasCamera = await QrScanner.hasCamera();
                this.addDebugLog(`카메라 사용 가능: ${hasCamera}`);
                
                try {
                    const cameras = await QrScanner.listCameras(true);
                    this.addDebugLog(`사용 가능한 카메라: ${cameras.length}개`);
                    cameras.forEach((camera, index) => {
                        this.addDebugLog(`  ${index + 1}. ${camera.label} (${camera.id})`);
                    });
                } catch (e) {
                    this.addDebugLog(`카메라 목록 확인 실패: ${e.message}`);
                }
                
                try {
                    const hasFlash = await this.scanner.hasFlash();
                    this.addDebugLog(`플래시 지원: ${hasFlash}`);
                } catch (e) {
                    this.addDebugLog(`플래시 확인 실패: ${e.message}`);
                }
                
            } catch (startError) {
                this.addDebugLog(`카메라 시작 실패: ${startError.message}`);
                throw startError;
            }
            
            this.addDebugLog('카메라 시작 성공!');
            this.isScanning = true;
            this.scanAttempts = 0;
            this.scanStartTime = Date.now();
            
            document.getElementById('startScanBtn').classList.add('hidden');
            document.getElementById('stopScanBtn').classList.remove('hidden');
            
            this.startScanMonitoring();
            
            if (this.currentStep === 1) {
                this.showStatus('카메라가 시작되었습니다. 개인키 QR 코드(빨간색)를 스캔해주세요.', 'info');
            } else {
                this.showStatus('카메라가 시작되었습니다. 결제정보 QR 코드(초록색)를 스캔해주세요.', 'info');
            }

        } catch (error) {
            this.addDebugLog(`스캐너 시작 실패: ${error.message}`);
            this.addDebugLog(`에러 스택: ${error.stack}`);
            
            this.showStatus('카메라 시작 실패: ' + error.message, 'error');
            this.showAlternativeOptions();
        }
    }

    stopScanner() {
        this.addDebugLog('📸 카메라 스캐너 정지 중...');
        
        this.isScanning = false;
        this.pauseScanning = false;
        this.stopScanMonitoring();
        
        if (this.scanner) {
            try {
                this.scanner.stop();
                this.scanner.destroy();
                this.addDebugLog('스캐너 인스턴스 정리 완료');
            } catch (error) {
                this.addDebugLog(`스캐너 정리 오류: ${error.message}`);
            } finally {
                this.scanner = null;
            }
        }
        
        this.cleanupVideoElement();
        
        document.getElementById('startScanBtn').classList.remove('hidden');
        document.getElementById('stopScanBtn').classList.add('hidden');
        this.showStatus('카메라가 정지되었습니다.', 'info');
    }
    
    cleanupVideoElement() {
        const video = document.getElementById('scanner-video');
        if (video && video.srcObject) {
            try {
                const tracks = video.srcObject.getTracks();
                tracks.forEach(track => {
                    track.stop();
                    this.addDebugLog(`📹 비디오 트랙 정지: ${track.kind}`);
                });
                video.srcObject = null;
                this.addDebugLog('비디오 엘리먼트 정리 완료');
            } catch (error) {
                this.addDebugLog(`비디오 엘리먼트 정리 오류: ${error.message}`);
            }
        }
    }

    handleQRResult(result) {
        try {
            this.addDebugLog(`QR 결과 처리 시작 (단계: ${this.currentStep}): ${result}`);
            
            this.stopScanner();
            
            if (typeof result !== 'string') {
                this.addDebugLog(`📝 QR 결과를 문자열로 변환: ${result}`);
                result = result.toString();
            }
            
            this.addDebugLog('📊 QR 데이터 파싱 시도');
            
            const qrData = JSON.parse(result);
            this.addDebugLog('QR 데이터 파싱 성공');
            
            if (this.currentStep === 1) {
                // 첫 번째 QR: 개인키 세션
                this.handlePrivateKeyQR(qrData);
            } else if (this.currentStep === 2) {
                // 두 번째 QR: 결제정보
                this.handlePaymentQR(qrData);
            }
            
        } catch (error) {
            this.addDebugLog(`QR 데이터 파싱 실패: ${error.message}`);
            this.addDebugLog(`📝 원본 QR 데이터: ${result}`);
            this.showStatus('유효하지 않은 QR 코드입니다: ' + error.message, 'error');
        }
    }

    async handlePrivateKeyQR(qrData) {
        this.addDebugLog('개인키 QR 처리 시작');
        
        if (qrData.type !== 'private_key_session') {
            throw new Error('개인키 QR 코드가 아닙니다. 빨간색 개인키 QR 코드를 스캔해주세요.');
        }

        this.privateKeyData = qrData;
        this.sessionId = qrData.sessionId;
        
        this.addDebugLog(`- 세션 ID: ${this.sessionId}`);
        this.addDebugLog(`- 만료 시간: ${new Date(qrData.expiresAt).toLocaleString()}`);

        try {
            // 서버에 개인키 세션 저장
            this.updatePaymentProgress('개인키를 안전하게 저장 중...');
            
            const response = await fetch('/scan/private-key', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(qrData)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
                throw new Error(errorData.message || `HTTP ${response.status}`);
            }

            const result = await response.json();
            this.addDebugLog('개인키 세션 저장 성공');

            // 다음 단계로 진행
            this.currentStep = 2;
            this.updateStepIndicator();
            
            // 섹션 전환
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentProcessing').classList.remove('hidden');
            
            this.updatePaymentProgress('개인키가 저장되었습니다. 이제 결제정보 QR 코드(초록색)를 스캔해주세요.');
            
            // 3초 후 자동으로 스캔 재시작
            setTimeout(() => {
                document.getElementById('paymentProcessing').classList.add('hidden');
                document.getElementById('scannerSection').classList.remove('hidden');
                this.startScanner();
            }, 3000);

        } catch (error) {
            this.addDebugLog(`개인키 세션 저장 실패: ${error.message}`);
            this.showStatus('개인키 저장 실패: ' + error.message, 'error');
        }
    }

    async handlePaymentQR(qrData) {
        this.addDebugLog('결제정보 QR 처리 시작');
        
        if (qrData.type !== 'payment_request') {
            throw new Error('결제정보 QR 코드가 아닙니다. 초록색 결제정보 QR 코드를 스캔해주세요.');
        }

        if (qrData.sessionId !== this.sessionId) {
            throw new Error('세션 ID가 일치하지 않습니다. 올바른 결제정보 QR 코드를 스캔해주세요.');
        }

        this.paymentData = qrData;
        
        this.addDebugLog(`- 금액: ${qrData.amount}`);
        this.addDebugLog(`- 수신자: ${qrData.recipient}`);
        this.addDebugLog(`- 토큰: ${qrData.token}`);
        
        // 섹션 전환
        document.getElementById('scannerSection').classList.add('hidden');
        document.getElementById('paymentProcessing').classList.remove('hidden');
        
        this.showStatus('결제정보 QR 코드를 스캔했습니다. 결제를 진행합니다...', 'success');
        
        // 결제 실행
        this.executePayment();
    }

    async executePayment() {
        if (!this.paymentData || !this.sessionId) {
            this.showStatus('결제 데이터가 없습니다.', 'error');
            return;
        }

        try {
            this.updatePaymentProgress('세션 결합 및 가스리스 결제 실행 중...');
            
            // 서버에 결제 세션 저장 및 결제 실행 요청
            const result = await this.sendSessionBasedPayment();
            
            // 성공 처리
            this.handlePaymentSuccess(result);

        } catch (error) {
            console.error('결제 실행 실패:', error);
            this.handlePaymentError(error);
        }
    }

    async sendSessionBasedPayment() {
        const response = await fetch('/scan/payment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(this.paymentData)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }

        return await response.json();
    }

    handlePaymentSuccess(result) {
        this.currentStep = 3;
        this.updateStepIndicator();
        
        // 결제 진행 섹션 숨기기
        document.getElementById('paymentProcessing').classList.add('hidden');
        
        // 결과 섹션 표시
        document.getElementById('resultSection').classList.remove('hidden');
        
        const resultInfo = document.getElementById('resultInfo');
        resultInfo.innerHTML = `
            <div class="status success">
                <h3>2단계 결제 완료!</h3>
                <strong>세션 ID:</strong> ${this.sessionId}<br>
                <strong>거래 해시:</strong> <a href="#" target="_blank">${this.shortenAddress(result.paymentResult?.txHash)}</a><br>
                <strong>상태:</strong> ${result.status}<br>
                <strong>완료 시간:</strong> ${new Date().toLocaleString()}
            </div>
            <div class="status info mt-2">
                2단계 가스리스 결제가 성공적으로 완료되었습니다!<br>
                개인키와 결제정보가 안전하게 처리되었습니다.<br>
                영수증이 자동으로 인쇄됩니다.
            </div>
        `;

        // 영수증 인쇄 호출 (서버에서 자동으로 처리되지만 프론트엔드에서도 추가 호출 가능)
        this.requestReceiptPrint(result);
    }

    async requestReceiptPrint(paymentResult) {
        try {
            this.addDebugLog('영수증 인쇄 요청 시작');
            
            const receiptData = {
                txHash: paymentResult.paymentResult?.txHash || paymentResult.txHash,
                amount: this.paymentData?.amount || 'N/A',
                token: this.paymentData?.token || 'N/A',
                from: 'QR_SCAN_USER',
                to: this.paymentData?.recipient || 'N/A',
                timestamp: new Date().toISOString(),
                status: 'success',
                sessionId: this.sessionId,
            };

            const response = await fetch('/receipt/print', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(receiptData)
            });

            if (response.ok) {
                const result = await response.json();
                this.addDebugLog(`영수증 인쇄 요청 성공: ${result.message}`);
                this.showStatus('영수증 인쇄가 요청되었습니다.', 'success');
            } else {
                throw new Error(`HTTP ${response.status}`);
            }

        } catch (error) {
            this.addDebugLog(`영수증 인쇄 요청 실패: ${error.message}`);
            this.showStatus('영수증 인쇄 요청에 실패했습니다.', 'warning');
            // 영수증 인쇄 실패는 결제 성공에 영향을 주지 않음
        }
    }

    updatePaymentProgress(message) {
        const progressText = document.getElementById('paymentProgressText');
        if (progressText) {
            progressText.textContent = message;
        }
    }

    handlePaymentError(error) {
        // 결제 진행 섹션 숨기기
        document.getElementById('paymentProcessing').classList.add('hidden');
        
        // 결과 섹션 표시 (에러 결과)
        document.getElementById('resultSection').classList.remove('hidden');
        
        const resultInfo = document.getElementById('resultInfo');
        resultInfo.innerHTML = `
            <div class="status error">
                <h3>2단계 결제 실패</h3>
                <strong>세션 ID:</strong> ${this.sessionId || 'N/A'}<br>
                <strong>현재 단계:</strong> ${this.currentStep === 1 ? '개인키 QR 스캔' : '결제정보 QR 스캔'}<br>
                <strong>오류 내용:</strong> ${error.message}<br>
                <strong>실패 시간:</strong> ${new Date().toLocaleString()}
            </div>
            <div class="status info mt-2">
                2단계 결제 처리 중 오류가 발생했습니다.<br>
                처음부터 다시 시도하거나 관리자에게 문의해주세요.
            </div>
        `;
        
        this.showStatus('결제 실행 실패: ' + error.message, 'error');
    }

    resetScanner() {
        this.addDebugLog('스캐너 상태 초기화 시작');
        
        if (this.isScanning) {
            this.stopScanner();
        }
        
        // 상태 초기화
        this.currentStep = 1;
        this.sessionId = null;
        this.privateKeyData = null;
        this.paymentData = null;
        this.scanAttempts = 0;
        this.lastScanTime = null;
        this.pauseScanning = false;
        
        // UI 초기화
        document.getElementById('scannerSection').classList.remove('hidden');
        document.getElementById('paymentProcessing').classList.add('hidden');
        document.getElementById('resultSection').classList.add('hidden');
        
        this.updateStepIndicator();
        
        const videoContainer = document.querySelector('.video-container');
        if (videoContainer) {
            videoContainer.style.transform = 'scale(1)';
        }
        
        this.addDebugLog('상태 초기화 완료');
        this.showStatus('새로운 2단계 QR 코드 스캔을 시작할 준비가 되었습니다.', 'info');
    }

    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    showAlternativeOptions() {
        const statusEl = document.getElementById('status');
        statusEl.className = 'status warning';
        statusEl.innerHTML = `
            카메라 스캔을 사용할 수 없습니다.<br>
            <strong>해결 방법:</strong><br>
            1. 다른 브라우저를 사용해보세요 (Chrome, Safari)<br>
            2. 브라우저 설정에서 카메라 권한을 허용해주세요<br>
            3. 페이지를 새로고침 후 다시 시도해주세요
        `;
        statusEl.classList.remove('hidden');
    }

    addDebugLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.debugLogs.push(`[${timestamp}] ${message}`);
        
        if (this.debugLogs.length > 50) {
            this.debugLogs.shift();
        }
        
        console.log(message);
    }

    startScanMonitoring() {
        this.scanMonitorInterval = setInterval(() => {
            if (this.isScanning) {
                this.updateScanningStatus();
            }
        }, 3000);
    }
    
    stopScanMonitoring() {
        if (this.scanMonitorInterval) {
            clearInterval(this.scanMonitorInterval);
            this.scanMonitorInterval = null;
        }
    }
    
    updateScanningStatus() {
        if (!this.isScanning) return;
        
        const statusEl = document.getElementById('status');
        if (statusEl && !statusEl.classList.contains('error')) {
            const stepText = this.currentStep === 1 ? '개인키 QR 코드(빨간색)' : '결제정보 QR 코드(초록색)';
            statusEl.className = 'status info';
            statusEl.innerHTML = `🔍 ${stepText}를 스캔하는 중입니다...`;
            statusEl.classList.remove('hidden');
        }
    }
    
    showQRDetectedFeedback() {
        const statusEl = document.getElementById('status');
        const stepText = this.currentStep === 1 ? '개인키 QR' : '결제정보 QR';
        statusEl.className = 'status success';
        statusEl.innerHTML = `🎉 ${stepText} 코드 감지! 데이터 처리 중...`;
        statusEl.classList.remove('hidden');
        
        if ('vibrate' in navigator) {
            navigator.vibrate(200);
        }
        
        this.addDebugLog(`🎉 ${stepText} 코드 감지됨! 처리 시작`);
    }

    showStatus(message, type) {
        const statusEl = document.getElementById('status');
        statusEl.className = `status ${type}`;
        statusEl.textContent = message;
        statusEl.classList.remove('hidden');

        this.addDebugLog(`상태 메시지 (${type}): ${message}`);

        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                if (statusEl.textContent === message) {
                    statusEl.classList.add('hidden');
                }
            }, 5000);
        }
        
        if (type === 'success' && 'vibrate' in navigator) {
            navigator.vibrate([100, 50, 100]);
        } else if (type === 'error' && 'vibrate' in navigator) {
            navigator.vibrate([200, 100, 200, 100, 200]);
        }
    }
    
    bindMobileTouchEvents() {
        const videoContainer = document.querySelector('.video-container');
        if (!videoContainer) return;
        
        videoContainer.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.addDebugLog('카메라 영역 터치 감지');
            
            videoContainer.style.transform = 'scale(0.98)';
            setTimeout(() => {
                videoContainer.style.transform = 'scale(1)';
            }, 150);
            
            if ('vibrate' in navigator) {
                navigator.vibrate(50);
            }
        });
        
        if (screen.orientation) {
            screen.orientation.addEventListener('change', () => {
                this.addDebugLog(`화면 회전: ${screen.orientation.angle}°`);
                setTimeout(() => {
                    if (this.scanner && this.isScanning) {
                        this.addDebugLog('회전 후 스캔 설정 업데이트');
                    }
                }, 500);
            });
        }
    }
    
    handleVisibilityChange() {
        if (document.hidden) {
            if (this.isScanning) {
                this.addDebugLog('페이지 비활성화, 스캔 일시 중단');
                this.pauseScanning = true;
            }
        } else {
            if (this.isScanning && this.pauseScanning) {
                this.addDebugLog('페이지 재활성화, 스캔 재개');
                this.pauseScanning = false;
            }
        }
    }
}

// 페이지 로드 시 초기화
let dualQRPaymentScannerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    dualQRPaymentScannerInstance = new DualQRPaymentScanner();
});

// 페이지 떠나기 전 정리
window.addEventListener('beforeunload', () => {
    if (dualQRPaymentScannerInstance && dualQRPaymentScannerInstance.isScanning) {
        dualQRPaymentScannerInstance.stopScanner();
    }
});
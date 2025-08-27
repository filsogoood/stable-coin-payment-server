// QR 스캔 및 결제 처리 JavaScript

class PaymentScanner {
    constructor() {
        this.scanner = null;
        this.paymentData = null;
        this.provider = null;
        this.wallet = null;
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
    }

    bindEvents() {
        document.getElementById('startScanBtn').addEventListener('click', () => this.startScanner());
        document.getElementById('stopScanBtn').addEventListener('click', () => this.stopScanner());
        document.getElementById('qrFileInput').addEventListener('change', (e) => this.handleFileUpload(e));
        document.getElementById('executePaymentBtn').addEventListener('click', () => this.executePayment());
        document.getElementById('cancelPaymentBtn').addEventListener('click', () => this.cancelPayment());
        document.getElementById('newScanBtn').addEventListener('click', () => this.resetScanner());
        document.getElementById('toggleDebugBtn').addEventListener('click', () => this.toggleDebugSection());
        
        // 모바일 터치 이벤트 지원
        this.bindMobileTouchEvents();
        
        // 페이지 가시성 변경 이벤트 (성능 최적화)
        document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    }

    initializeEthers() {
        // 라이브러리 로드 상태 확인
        this.addDebugLog('🔍 라이브러리 로드 상태 확인 시작');
        
        const qrScannerStatus = typeof QrScanner !== 'undefined';
        const ethersStatus = typeof ethers !== 'undefined';
        
        this.addDebugLog(`- QrScanner: ${qrScannerStatus ? '✅ 로드됨' : '❌ 로드 실패'}`);
        this.addDebugLog(`- ethers: ${ethersStatus ? '✅ 로드됨' : '❌ 로드 실패'}`);
        
        // 브라우저 및 환경 정보
        this.addDebugLog(`- User Agent: ${navigator.userAgent}`);
        this.addDebugLog(`- Protocol: ${location.protocol}`);
        this.addDebugLog(`- MediaDevices: ${!!navigator.mediaDevices ? '✅' : '❌'}`);
        this.addDebugLog(`- getUserMedia: ${!!navigator.mediaDevices?.getUserMedia ? '✅' : '❌'}`);
        
        // 카메라 권한 확인
        if (navigator.permissions) {
            navigator.permissions.query({name: 'camera'}).then(result => {
                this.addDebugLog(`- 카메라 권한: ${result.state}`);
            }).catch(e => {
                this.addDebugLog(`- 카메라 권한 확인 실패: ${e.message}`);
            });
        }
        
        if (!qrScannerStatus) {
            this.addDebugLog('❌ QR 스캐너 라이브러리 로드 실패');
            this.showStatus('QR 스캐너 라이브러리 로드 실패', 'error');
            return;
        }
        
        if (!ethersStatus) {
            this.addDebugLog('❌ Ethers.js 라이브러리 로드 실패');
            this.showStatus('Ethers.js 라이브러리 로드 실패', 'error');
            return;
        }
        
        this.addDebugLog('✅ 모든 라이브러리 로드 완료');
        this.showStatus('모든 라이브러리가 로드되었습니다.', 'info');
        
        this.updateDebugDisplay();
    }

    async startScanner() {
        try {
            this.addDebugLog('📱 QR 스캐너 시작 중...');
            
            // 모바일 기기 감지 (전체 함수에서 사용)
            const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            this.addDebugLog(`📱 모바일 기기 감지: ${isMobile}`);
            
            // 기본 지원 확인
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('카메라가 지원되지 않는 브라우저입니다.');
            }
            
            // QrScanner 라이브러리 확인
            if (typeof QrScanner === 'undefined') {
                throw new Error('QR 스캐너 라이브러리가 로드되지 않았습니다.');
            }
            
            this.addDebugLog('✅ 카메라 및 라이브러리 지원 확인됨');

            const video = document.getElementById('scanner-video');
            
            // 비디오 엘리먼트 확인
            if (!video) {
                throw new Error('비디오 엘리먼트를 찾을 수 없습니다.');
            }
            
            this.addDebugLog('📹 비디오 엘리먼트 확인됨');
            
            // 명시적 카메라 권한 요청 (모바일 브라우저용)
            this.addDebugLog('📸 카메라 권한 요청 중...');
            try {
                // 모바일 최적화된 카메라 설정
                const constraints = {
                    video: {
                        facingMode: 'environment', // 후면 카메라 우선
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
                        // 모바일에서 성능 최적화
                        aspectRatio: isMobile ? { ideal: 4/3 } : { ideal: 16/9 }
                    }
                };
                
                this.addDebugLog(`📹 카메라 제약 조건: ${JSON.stringify(constraints.video)}`);
                
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                // 임시 스트림 정지 (권한 확인용)
                stream.getTracks().forEach(track => track.stop());
                this.addDebugLog('✅ 카메라 권한 확인 성공');
                            } catch (permError) {
                    this.addDebugLog(`❌ 카메라 권한 거부: ${permError.message}`);
                    throw new Error('카메라 권한이 필요합니다. 브라우저 설정에서 카메라 접근을 허용해주세요.');
                }
            
                        // QR 스캐너 초기화 (모바일 최적화)
            this.scanner = new QrScanner(
                video,
                result => {
                    this.addDebugLog(`🎯 QR 코드 스캔 성공: ${result.data || result}`);
                    this.updateDebugDisplay();
                    this.showQRDetectedFeedback();
                    this.handleQRResult(result.data || result);
                },
                {
                    // 새 API 사용으로 상세 결과 반환
                    returnDetailedScanResult: true,
                    
                    onDecodeError: error => {
                        // 일시 중단 상태이면 스캔 시도 카운트 안함
                        if (this.pauseScanning) {
                            return;
                        }
                        
                        this.scanAttempts++;
                        this.lastScanTime = new Date().toLocaleTimeString();
                        
                        // 모든 스캔 시도를 로깅 (디버깅용)
                        if (this.scanAttempts % 5 === 0) { // 5번마다 상태 업데이트
                            this.updateScanningStatus();
                        }
                        
                        // 스캔 시도 카운터 비상적 증가 감지
                        if (this.scanAttempts % 50 === 0) {
                            this.addDebugLog(`⚠️ ${this.scanAttempts}회 시도 후도 QR 코드 비인식. 카메라 상태 확인 필요`);
                        }
                        
                        // 에러 로깅 (일반적인 'No QR code found' 제외)
                        if (error && !error.toString().includes('No QR code found')) {
                            this.addDebugLog(`⚠️ QR 스캔 오류: ${error}`);
                            
                            // 심각한 에러의 경우 스캔 중단 고려
                            if (error.toString().includes('NetworkError') || 
                                error.toString().includes('NotReadableError')) {
                                this.addDebugLog('❌ 카메라 오류 감지, 스캔 중단 고려');
                                this.showStatus('카메라 오류가 발생했습니다. 다시 시도해주세요.', 'error');
                            }
                        }
                    },
                    
                    // 시각적 하이라이트
                    highlightScanRegion: true,
                    highlightCodeOutline: true,
                    
                    // 후면 카메라 우선
                    preferredCamera: 'environment',
                    
                    // 모바일 최적화: 스캔 빈도 조정
                    maxScansPerSecond: isMobile ? 8 : 15, // 모바일에서 더 낮은 빈도로 성능 최적화
                    
                    // 모바일 카메라에 최적화된 스캔 영역 설정
                    calculateScanRegion: (video) => {
                        this.addDebugLog(`📹 비디오 크기: ${video.videoWidth}x${video.videoHeight}`);
                        
                        const width = video.videoWidth;
                        const height = video.videoHeight;
                        const minDimension = Math.min(width, height);
                        
                        // 모바일에서 더 넓은 스캔 영역 사용
                        const scanRatio = isMobile ? 0.85 : 0.75; // 모바일에서 더 넓은 영역
                        const scanSize = Math.floor(minDimension * scanRatio);
                        
                        // 모바일에서 성능 고려한 다운스케일링
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
                        
                        this.addDebugLog(`🎯 스캔 영역: ${region.width}x${region.height} at (${region.x},${region.y})`);
                        this.addDebugLog(`🔍 다운스케일: ${region.downScaledWidth}x${region.downScaledHeight}`);
                        return region;
                    }
                }
            );
            
            this.addDebugLog('🔧 QR 스캐너 인스턴스 생성됨');

            // 카메라 시작 및 상세 상태 확인
            this.addDebugLog('📸 카메라 시작 중...');
            
            try {
                await this.scanner.start();
                
                // 카메라 시작 후 상세 정보 로깅
                const hasCamera = await QrScanner.hasCamera();
                this.addDebugLog(`📷 카메라 사용 가능: ${hasCamera}`);
                
                // 카메라 목록 확인
                try {
                    const cameras = await QrScanner.listCameras(true);
                    this.addDebugLog(`📷 사용 가능한 카메라: ${cameras.length}개`);
                    cameras.forEach((camera, index) => {
                        this.addDebugLog(`  ${index + 1}. ${camera.label} (${camera.id})`);
                    });
                } catch (e) {
                    this.addDebugLog(`⚠️ 카메라 목록 확인 실패: ${e.message}`);
                }
                
                // 플래시 지원 확인
                try {
                    const hasFlash = await this.scanner.hasFlash();
                    this.addDebugLog(`🔦 플래시 지원: ${hasFlash}`);
                } catch (e) {
                    this.addDebugLog(`⚠️ 플래시 확인 실패: ${e.message}`);
                }
                
            } catch (startError) {
                this.addDebugLog(`❌ 카메라 시작 실패: ${startError.message}`);
                throw startError;
            }
            
            this.addDebugLog('✅ 카메라 시작 성공!');
            this.isScanning = true;
            this.scanAttempts = 0;
            this.scanStartTime = Date.now(); // 스캔 시작 시간 기록
            this.updateDebugDisplay();
            
            document.getElementById('startScanBtn').classList.add('hidden');
            document.getElementById('stopScanBtn').classList.remove('hidden');
            
            // 스캔 상태 모니터링 시작
            this.startScanMonitoring();
            
            this.showStatus('카메라가 시작되었습니다. QR 코드를 스캔해주세요.', 'info');

        } catch (error) {
            this.addDebugLog(`❌ 스캐너 시작 실패: ${error.message}`);
            this.addDebugLog(`❌ 에러 스택: ${error.stack}`);
            this.updateDebugDisplay();
            
            this.showStatus('카메라 시작 실패: ' + error.message, 'error');
            
            // 대안 제시
            this.showAlternativeOptions();
        }
    }

    stopScanner() {
        this.addDebugLog('📸 카메라 스캐너 정지 중...');
        
        this.isScanning = false;
        this.pauseScanning = false;
        this.stopScanMonitoring();
        
        // 스캐너 인스턴스 정리
        if (this.scanner) {
            try {
                this.scanner.stop();
                this.scanner.destroy();
                this.addDebugLog('✅ 스캐너 인스턴스 정리 완료');
            } catch (error) {
                this.addDebugLog(`⚠️ 스캐너 정리 오류: ${error.message}`);
            } finally {
                this.scanner = null;
            }
        }
        
        // 비디오 엘리먼트 정리
        this.cleanupVideoElement();
        
        // UI 상태 업데이트
        document.getElementById('startScanBtn').classList.remove('hidden');
        document.getElementById('stopScanBtn').classList.add('hidden');
        
        this.updateDebugDisplay();
        this.showStatus('카메라가 정지되었습니다.', 'info');
    }
    
    cleanupVideoElement() {
        const video = document.getElementById('scanner-video');
        if (video && video.srcObject) {
            try {
                // 비디오 스트림 정리
                const tracks = video.srcObject.getTracks();
                tracks.forEach(track => {
                    track.stop();
                    this.addDebugLog(`📹 비디오 트랙 정지: ${track.kind}`);
                });
                video.srcObject = null;
                this.addDebugLog('✅ 비디오 엘리먼트 정리 완료');
            } catch (error) {
                this.addDebugLog(`⚠️ 비디오 엘리먼트 정리 오류: ${error.message}`);
            }
        }
    }

    async handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        this.addDebugLog(`📁 파일 업로드: ${file.name} (${file.size} bytes)`);
        this.updateDebugDisplay();

        try {
            this.addDebugLog('🔍 파일에서 QR 코드 스캔 시도...');
            const result = await QrScanner.scanImage(file);
            this.addDebugLog(`✅ 파일 스캔 성공: ${result}`);
            this.updateDebugDisplay();
            this.handleQRResult(result);
        } catch (error) {
            this.addDebugLog(`❌ 파일 스캔 실패: ${error.message}`);
            this.updateDebugDisplay();
            this.showStatus('QR 코드를 찾을 수 없습니다.', 'error');
        }
    }

    handleQRResult(result) {
        try {
            this.addDebugLog(`🎉 QR 결과 처리 시작: ${result}`);
            
            this.stopScanner();
            
            // QR 결과가 문자열인지 확인
            if (typeof result !== 'string') {
                this.addDebugLog(`📝 QR 결과를 문자열로 변환: ${result}`);
                result = result.toString();
            }
            
            this.addDebugLog('📊 QR 데이터 파싱 시도');
            
            // QR 데이터 파싱
            const paymentData = JSON.parse(result);
            this.addDebugLog('✅ QR 데이터 파싱 성공');
            this.addDebugLog(`- 금액: ${paymentData.amount}`);
            this.addDebugLog(`- 수신자: ${paymentData.recipient}`);
            this.addDebugLog(`- 토큰: ${paymentData.token}`);
            this.updateDebugDisplay();
            
            this.paymentData = paymentData;
            
            // 결제 정보 표시
            this.displayPaymentInfo(paymentData);
            
            // 섹션 전환
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentSection').classList.remove('hidden');
            
            this.showStatus('QR 코드를 성공적으로 스캔했습니다!', 'success');
            
        } catch (error) {
            this.addDebugLog(`❌ QR 데이터 파싱 실패: ${error.message}`);
            this.addDebugLog(`📝 원본 QR 데이터: ${result}`);
            this.updateDebugDisplay();
            this.showStatus('유효하지 않은 QR 코드입니다: ' + error.message, 'error');
        }
    }

    displayPaymentInfo(data) {
        const paymentInfo = document.getElementById('paymentInfo');
        
        const infoHtml = `
            <div class="status info">
                <h3>📋 결제 정보</h3>
                <strong>💰 금액:</strong> ${data.amount} WEI<br>
                <strong>📧 받는 주소:</strong> ${this.shortenAddress(data.recipient)}<br>
                <strong>🪙 토큰 주소:</strong> ${this.shortenAddress(data.token)}<br>
                <strong>🔗 체인 ID:</strong> ${data.chainId}<br>
                <strong>🌐 서버 URL:</strong> ${data.serverUrl}<br>
                <strong>🔐 개인키 필요:</strong> ${data.privateKeyRequired ? '예' : '아니오'}<br>
                <strong>⏰ QR 생성 시간:</strong> ${new Date(data.timestamp).toLocaleString()}
            </div>
            <div class="status warning mt-2">
                <strong>⚠️ 확인 필요:</strong><br>
                위 정보가 정확한지 확인한 후 "가스리스 결제 실행" 버튼을 클릭하세요.
                ${data.privateKeyRequired ? '개인키는 서버에서 안전하게 요청됩니다.' : ''}
                이 거래는 취소할 수 없습니다.
            </div>
        `;
        
        paymentInfo.innerHTML = infoHtml;
    }

    async executePayment() {
        if (!this.paymentData) {
            this.showStatus('결제 데이터가 없습니다.', 'error');
            return;
        }

        try {
            this.setPaymentLoading(true);
            
            this.showStatus('서버에 가스리스 결제 요청 중...', 'info');
            
            // 서버에 가스리스 결제 요청
            const result = await this.sendGaslessPayment();
            
            // 성공 처리
            this.handlePaymentSuccess(result);

        } catch (error) {
            console.error('결제 실행 실패:', error);
            this.showStatus('결제 실행 실패: ' + error.message, 'error');
        } finally {
            this.setPaymentLoading(false);
        }
    }

    async sendGaslessPayment() {
        // 서버에 가스리스 결제 요청
        const requestBody = {
            qrData: {
                token: this.paymentData.token,
                to: this.paymentData.recipient, // QR 데이터의 필드명은 recipient
                amountWei: this.paymentData.amount, // QR 데이터의 필드명은 amount
                chainId: this.paymentData.chainId,
                delegateAddress: this.paymentData.delegateAddress,
                rpcUrl: this.paymentData.rpcUrl,
                serverUrl: this.paymentData.serverUrl,
                timestamp: this.paymentData.timestamp
            }
        };

        const response = await fetch(`${this.paymentData.serverUrl}/gasless-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }

        return await response.json();
    }

    handlePaymentSuccess(result) {
        // 결제 섹션 숨기기
        document.getElementById('paymentSection').classList.add('hidden');
        
        // 결과 섹션 표시
        document.getElementById('resultSection').classList.remove('hidden');
        
        const resultInfo = document.getElementById('resultInfo');
        resultInfo.innerHTML = `
            <div class="status success">
                <h3>✅ 결제 완료!</h3>
                <strong>거래 해시:</strong> <a href="#" target="_blank">${this.shortenAddress(result.txHash)}</a><br>
                <strong>상태:</strong> ${result.status}<br>
                <strong>완료 시간:</strong> ${new Date().toLocaleString()}
            </div>
            <div class="status info mt-2">
                가스리스 결제가 성공적으로 완료되었습니다!<br>
                블록체인에서 거래가 확인될 때까지 잠시 기다려주세요.
            </div>
        `;
    }

    cancelPayment() {
        document.getElementById('paymentSection').classList.add('hidden');
        this.resetScanner();
    }

    resetScanner() {
        this.addDebugLog('🔄 스캐너 상태 초기화 시작');
        
        // 스캐너 완전 정지
        if (this.isScanning) {
            this.stopScanner();
        }
        
        // 모든 섹션 초기화
        document.getElementById('scannerSection').classList.remove('hidden');
        document.getElementById('paymentSection').classList.add('hidden');
        document.getElementById('resultSection').classList.add('hidden');
        
        // 데이터 초기화
        this.paymentData = null;
        this.wallet = null;
        this.provider = null;
        this.scanAttempts = 0;
        this.lastScanTime = null;
        this.pauseScanning = false;
        
        // 파일 입력 초기화
        const fileInput = document.getElementById('qrFileInput');
        if (fileInput) {
            fileInput.value = '';
        }
        
        // 비디오 컨테이너 스타일 초기화
        const videoContainer = document.querySelector('.video-container');
        if (videoContainer) {
            videoContainer.style.transform = 'scale(1)';
        }
        
        this.addDebugLog('✅ 상태 초기화 완료');
        this.updateDebugDisplay();
        this.showStatus('새로운 QR 코드를 스캔할 준비가 되었습니다.', 'info');
    }

    setPaymentLoading(loading) {
        const btn = document.getElementById('executePaymentBtn');
        const text = document.getElementById('paymentText');
        const loadingEl = document.getElementById('paymentLoading');

        btn.disabled = loading;
        text.classList.toggle('hidden', loading);
        loadingEl.classList.toggle('hidden', !loading);
    }

    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    showAlternativeOptions() {
        // 카메라 스캔 실패 시 대안 옵션 제시
        const statusEl = document.getElementById('status');
        statusEl.className = 'status warning';
        statusEl.innerHTML = `
            ⚠️ 카메라 스캔을 사용할 수 없습니다.<br>
            <strong>대안 방법:</strong><br>
            1. 다른 브라우저를 사용해보세요 (Chrome, Safari)<br>
            2. 브라우저 설정에서 카메라 권한을 허용해주세요<br>
            3. 아래 파일 업로드를 사용해주세요
        `;
        statusEl.classList.remove('hidden');
        
        // 파일 업로드 섹션을 더 눈에 띄게 표시
        const fileSection = document.getElementById('fileUploadSection');
        if (fileSection) {
            fileSection.style.backgroundColor = '#fff3cd';
            fileSection.style.border = '2px solid #ffeaa7';
            fileSection.style.borderRadius = '8px';
            fileSection.style.padding = '1rem';
        }
    }

    addDebugLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.debugLogs.push(`[${timestamp}] ${message}`);
        
        // 최대 50개 로그만 유지
        if (this.debugLogs.length > 50) {
            this.debugLogs.shift();
        }
        
        // 콘솔에도 출력
        console.log(message);
    }

    updateDebugDisplay() {
        const debugInfo = document.getElementById('debugInfo');
        if (debugInfo && this.debugLogs.length > 0) {
            const recentLogs = this.debugLogs.slice(-10); // 최근 10개만 표시
            debugInfo.innerHTML = recentLogs.map(log => `<div>${log}</div>`).join('');
        }
    }

    toggleDebugSection() {
        const debugSection = document.getElementById('debugSection');
        const toggleBtn = document.getElementById('toggleDebugBtn');
        
        if (debugSection.style.display === 'none') {
            debugSection.style.display = 'block';
            toggleBtn.textContent = '디버깅 정보 숨기기';
        } else {
            debugSection.style.display = 'none';
            toggleBtn.textContent = '디버깅 정보 보기';
        }
    }

    startScanMonitoring() {
        // 3초마다 스캔 상태 업데이트 (더 자주 체크)
        this.scanMonitorInterval = setInterval(() => {
            if (this.isScanning) {
                this.updateScanningStatus();
                
                // 30초 동안 스캔 시도가 없으면 문제 진단
                if (this.scanAttempts === 0 && Date.now() - this.scanStartTime > 30000) {
                    this.addDebugLog('⚠️ 30초 동안 스캔 시도 없음. 카메라 또는 라이브러리 문제 가능성');
                    this.diagnoseScannerIssues();
                }
            }
        }, 3000);
        
        // 즉시 상태 업데이트
        setTimeout(() => this.updateScanningStatus(), 1000);
    }
    
    async diagnoseScannerIssues() {
        this.addDebugLog('🔍 스캐너 문제 진단 시작...');
        
        // 비디오 스트림 상태 확인
        const video = document.getElementById('scanner-video');
        if (video) {
            this.addDebugLog(`📹 비디오 상태: width=${video.videoWidth}, height=${video.videoHeight}, readyState=${video.readyState}`);
            this.addDebugLog(`📹 비디오 속성: paused=${video.paused}, ended=${video.ended}`);
            
            if (video.videoWidth === 0 || video.videoHeight === 0) {
                this.addDebugLog('❌ 비디오 스트림이 제대로 로드되지 않음');
            }
        }
        
        // 스캐너 상태 확인
        if (this.scanner) {
            try {
                const hasCamera = await QrScanner.hasCamera();
                this.addDebugLog(`📷 카메라 사용 가능: ${hasCamera}`);
            } catch (e) {
                this.addDebugLog(`❌ 카메라 상태 확인 실패: ${e.message}`);
            }
        }
        
        this.updateDebugDisplay();
    }
    
    stopScanMonitoring() {
        if (this.scanMonitorInterval) {
            clearInterval(this.scanMonitorInterval);
            this.scanMonitorInterval = null;
        }
    }
    
    updateScanningStatus() {
        if (!this.isScanning) return;
        
        const statusMessage = `🔍 QR 코드 스캔 중... (시도: ${this.scanAttempts}회)`;
        
        if (this.lastScanTime) {
            this.addDebugLog(`🔍 마지막 스캔: ${this.lastScanTime} (총 ${this.scanAttempts}회 시도)`);
        }
        
        // 스캔 빈도 계산 및 로깅
        if (this.scanAttempts > 0) {
            const scanRate = this.scanAttempts / ((Date.now() - this.scanStartTime) / 1000);
            this.addDebugLog(`📈 스캔 빈도: ${scanRate.toFixed(1)}회/초`);
        }
        
        this.updateDebugDisplay();
        
        // 상태 표시 업데이트
        const statusEl = document.getElementById('status');
        if (statusEl && !statusEl.classList.contains('error')) {
            statusEl.className = 'status info';
            let statusHTML = statusMessage;
            
            if (this.scanAttempts === 0) {
                statusHTML += '<br><small>⚠️ 스캔이 시작되지 않았습니다. 디버깅 정보를 확인해주세요.</small>';
            } else if (this.scanAttempts < 10) {
                statusHTML += '<br><small>🎥 QR 코드를 카메라 중앙에 대주세요</small>';
            } else {
                statusHTML += '<br><small>🔍 스캔 중... 조명을 밝게 하거나 QR 코드를 가깝게 대보세요</small>';
            }
            
            statusEl.innerHTML = statusHTML;
            statusEl.classList.remove('hidden');
        }
    }
    
    showQRDetectedFeedback() {
        // QR 코드 감지 시 즉시 피드백
        const statusEl = document.getElementById('status');
        statusEl.className = 'status success';
        statusEl.innerHTML = '🎉 QR 코드 감지! 데이터 처리 중...';
        statusEl.classList.remove('hidden');
        
        // 비프음 사운드 또는 진동 (지원되는 경우)
        if ('vibrate' in navigator) {
            navigator.vibrate(200);
        }
        
        this.addDebugLog('🎉 QR 코드 감지됨! 처리 시작');
        this.updateDebugDisplay();
    }

    showStatus(message, type) {
        const statusEl = document.getElementById('status');
        statusEl.className = `status ${type}`;
        statusEl.textContent = message;
        statusEl.classList.remove('hidden');

        // 디버깅 로그에도 추가
        this.addDebugLog(`💬 상태 메시지 (${type}): ${message}`);
        this.updateDebugDisplay();

        // 성공/정보 메시지는 5초 후 자동 숨김
        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                if (statusEl.textContent === message) { // 다른 메시지로 바뀌지 않았을 때만
                    statusEl.classList.add('hidden');
                }
            }, 5000);
        }
        
        // 모바일 진동 피드백
        if (type === 'success' && 'vibrate' in navigator) {
            navigator.vibrate([100, 50, 100]); // 성공 패턴
        } else if (type === 'error' && 'vibrate' in navigator) {
            navigator.vibrate([200, 100, 200, 100, 200]); // 에러 패턴
        }
    }
    
    bindMobileTouchEvents() {
        const videoContainer = document.querySelector('.video-container');
        if (!videoContainer) return;
        
        // 비디오 컨테이너 터치 이벤트
        videoContainer.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.addDebugLog('👆 카메라 영역 터치 감지');
            
            // 터치 시 시각적 피드백
            videoContainer.style.transform = 'scale(0.98)';
            setTimeout(() => {
                videoContainer.style.transform = 'scale(1)';
            }, 150);
            
            // 진동 피드백
            if ('vibrate' in navigator) {
                navigator.vibrate(50);
            }
        });
        
        // 스크린 회전 감지
        if (screen.orientation) {
            screen.orientation.addEventListener('change', () => {
                this.addDebugLog(`🔄 화면 회전: ${screen.orientation.angle}°`);
                // 회전 후 약간의 지연 후 스캔 영역 재계산
                setTimeout(() => {
                    if (this.scanner && this.isScanning) {
                        this.addDebugLog('🔄 회전 후 스캔 설정 업데이트');
                        // 스캔 영역 재계산을 위해 잠시 중단 후 재시작
                        // 너무 급진적이지 않게 처리
                    }
                }, 500);
            });
        }
    }
    
    handleVisibilityChange() {
        if (document.hidden) {
            // 페이지가 숨겨지면 스캔 일시 중단
            if (this.isScanning) {
                this.addDebugLog('🙈 페이지 비활성화, 스캔 일시 중단');
                this.pauseScanning = true;
            }
        } else {
            // 페이지가 다시 활성화되면 스캔 재개
            if (this.isScanning && this.pauseScanning) {
                this.addDebugLog('👁️ 페이지 재활성화, 스캔 재개');
                this.pauseScanning = false;
            }
        }
    }
}

// 페이지 로드 시 초기화
let paymentScannerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    paymentScannerInstance = new PaymentScanner();
});

// 페이지 떠나기 전 정리
window.addEventListener('beforeunload', () => {
    if (paymentScannerInstance && paymentScannerInstance.isScanning) {
        paymentScannerInstance.stopScanner();
    }
});

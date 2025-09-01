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
        this.walletPrivateKey = null; // 첫 번째 QR에서 저장된 개인키
        this.lastScannedQR = null; // 마지막으로 스캔한 QR 데이터 (중복 방지용)
        this.firstQRScanned = false; // 첫 번째 QR 스캔 완료 여부
        this.serverConfig = null; // 서버에서 가져온 설정
        this.init();
    }

    async init() {
        this.bindEvents();
        this.initializeEthers();
        await this.loadServerConfig();
        this.checkForStoredWalletInfo();
    }

    async loadServerConfig() {
        try {
            this.addDebugLog('서버 설정 로드 중...');
            const response = await fetch('/api/config');
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            this.serverConfig = await response.json();
            this.addDebugLog(`서버 설정 로드 성공: ${this.serverConfig.serverUrl}`);
            
        } catch (error) {
            this.addDebugLog(`서버 설정 로드 실패: ${error.message}`);
            this.addDebugLog('기본 설정값을 사용합니다.');
            
            // 기본값 설정
            this.serverConfig = {
                serverUrl: window.location.origin, // 현재 도메인 사용
                chainId: '11155111',
                token: null,
                rpcUrl: null
            };
        }
    }
    
    checkForStoredWalletInfo() {
        // URL 쿼리 파라미터에서 개인키 확인 (새로운 방식)
        const urlParams = new URLSearchParams(window.location.search);
        const urlPrivateKey = urlParams.get('pk');
        const urlTimestamp = urlParams.get('t');
        
        if (urlPrivateKey) {
            this.addDebugLog('URL 파라미터로 전달된 개인키 발견');
            this.addDebugLog(`- 개인키: ${urlPrivateKey.substring(0, 10)}...`);
            this.addDebugLog(`- 타임스탬프: ${urlTimestamp ? new Date(parseInt(urlTimestamp)).toLocaleString() : '없음'}`);
            
            // 개인키 설정
            this.walletPrivateKey = urlPrivateKey;
            this.firstQRScanned = true;
            
            // URL에서 파라미터 제거 (보안상)
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
            
            // 사용자에게 알림
            this.showStatus('첫 번째 QR 코드로부터 지갑 정보가 설정되었습니다. 잔고를 조회하는 중...', 'success');
            
            // 스캔 가이드 업데이트
            const scanGuide = document.querySelector('.scan-instruction');
            if (scanGuide) {
                scanGuide.textContent = '직접 결제 QR 코드를 스캔해주세요';
                scanGuide.style.color = '#e74c3c';
            }
            
            // 잔고 조회
            this.fetchAndDisplayBalance();
            
            return;
        }
        
        // 기존 localStorage 방식도 유지 (호환성)
        const storedPrivateKey = localStorage.getItem('temp_wallet_private_key');
        const storedTimestamp = localStorage.getItem('temp_wallet_timestamp');
        
        if (storedPrivateKey) {
            this.addDebugLog('localStorage에서 개인키 발견');
            this.addDebugLog(`- 개인키: ${storedPrivateKey.substring(0, 10)}...`);
            this.addDebugLog(`- 타임스탬프: ${new Date(parseInt(storedTimestamp || '0')).toLocaleString()}`);
            
            // 개인키 설정
            this.walletPrivateKey = storedPrivateKey;
            this.firstQRScanned = true;
            
            // 임시 저장된 데이터 정리
            localStorage.removeItem('temp_wallet_private_key');
            localStorage.removeItem('temp_wallet_timestamp');
            
            // 사용자에게 알림
            this.showStatus('첫 번째 QR 코드로부터 지갑 정보가 설정되었습니다. 잔고를 조회하는 중...', 'success');
            
            // 스캔 가이드 업데이트
            const scanGuide = document.querySelector('.scan-instruction');
            if (scanGuide) {
                scanGuide.textContent = '직접 결제 QR 코드를 스캔해주세요';
                scanGuide.style.color = '#e74c3c';
            }
            
            // 잔고 조회
            this.fetchAndDisplayBalance();
        }
    }

    bindEvents() {
        document.getElementById('startScanBtn').addEventListener('click', () => this.startScanner());
        document.getElementById('stopScanBtn').addEventListener('click', async () => await this.stopScanner());
        document.getElementById('newScanBtn').addEventListener('click', async () => await this.resetScanner());
        
        // 모바일 터치 이벤트 지원
        this.bindMobileTouchEvents();
        
        // 페이지 가시성 변경 이벤트 (성능 최적화)
        document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
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
            // 이미 스캐너가 실행 중인지 확인
            if (this.isScanning && this.scanner) {
                this.addDebugLog('스캐너가 이미 실행 중입니다. 중복 시작 방지.');
                return;
            }
            
            // 기존 스캐너가 있다면 먼저 정리
            if (this.scanner) {
                this.addDebugLog('기존 스캐너 인스턴스 정리 중...');
                await this.cleanupScanner();
            }
            
            this.addDebugLog('QR 스캐너 시작 중...');
            
            // 모바일 기기 감지 (전체 함수에서 사용)
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
            
            // 명시적 카메라 권한 요청 (모바일 브라우저용)
            this.addDebugLog('카메라 권한 요청 중...');
            try {
                // 모바일 최적화된 카메라 설정
                const constraints = {
                    video: {
                        facingMode: 'environment', // 후면 카메라 우선
                        width: { 
                            min: 640,
                            ideal: isMobile ? 1280 : 1280, // QR 인식을 위해 더 높은 해상도
                            max: 1920
                        },
                        height: { 
                            min: 480,
                            ideal: isMobile ? 960 : 720, // QR 인식을 위해 더 높은 해상도
                            max: 1080
                        },
                        frameRate: {
                            min: 15,
                            ideal: isMobile ? 25 : 30,
                            max: 30
                        },
                        // QR 코드 인식 최적화 (정사각형에 가까운 비율)
                        aspectRatio: isMobile ? { ideal: 1.0 } : { ideal: 4/3 }
                    }
                };
                
                this.addDebugLog(`📹 카메라 제약 조건: ${JSON.stringify(constraints.video)}`);
                
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                // 임시 스트림 정지 (권한 확인용)
                stream.getTracks().forEach(track => track.stop());
                this.addDebugLog('카메라 권한 확인 성공');
                            } catch (permError) {
                    this.addDebugLog(`카메라 권한 거부: ${permError.message}`);
                    throw new Error('카메라 권한이 필요합니다. 브라우저 설정에서 카메라 접근을 허용해주세요.');
                }
            
                        // QR 스캐너 초기화 (모바일 최적화)
            this.scanner = new QrScanner(
                video,
                async result => {
                    this.addDebugLog(`QR 코드 스캔 성공: ${result.data || result}`);
                    this.showQRDetectedFeedback();
                    await this.handleQRResult(result.data || result);
                },
                {
                    // 새 API 사용으로 상세 결과 반환
                    returnDetailedScanResult: true,
                    
                    // QR 코드 인식률 향상을 위한 추가 옵션
                    overlay: null, // 오버레이 비활성화로 성능 향상
                    
                    // 모바일 환경에서 지원되는 경우 워커 사용
                    worker: window.Worker ? true : false,
                    
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
                            this.addDebugLog(`${this.scanAttempts}회 시도 후도 QR 코드 비인식. 카메라 상태 확인 필요`);
                        }
                        
                        // 에러 로깅 (일반적인 'No QR code found' 제외)
                        if (error && !error.toString().includes('No QR code found')) {
                            this.addDebugLog(`QR 스캔 오류: ${error}`);
                            
                            // 심각한 에러의 경우 스캔 중단 고려
                            if (error.toString().includes('NetworkError') || 
                                error.toString().includes('NotReadableError')) {
                                this.addDebugLog('카메라 오류 감지, 스캔 중단 고려');
                                this.showStatus('카메라 오류가 발생했습니다. 다시 시도해주세요.', 'error');
                            }
                        }
                    },
                    
                    // 시각적 하이라이트
                    highlightScanRegion: true,
                    highlightCodeOutline: true,
                    
                    // 후면 카메라 우선
                    preferredCamera: 'environment',
                    
                    // 모바일 최적화: 스캔 빈도 조정 (더 낮은 빈도로 안정성 향상)
                    maxScansPerSecond: isMobile ? 4 : 10, // 모바일에서 더 안정적인 스캔을 위해 빈도 감소
                    
                    // 모바일 카메라에 최적화된 스캔 영역 설정
                    calculateScanRegion: (video) => {
                        const width = video.videoWidth;
                        const height = video.videoHeight;
                        const minDimension = Math.min(width, height);
                        
                        // 모바일에서 더 넓은 스캔 영역 사용 (인식률 향상)
                        const scanRatio = isMobile ? 0.95 : 0.85; // 더 넓은 스캔 영역으로 증가
                        const scanSize = Math.floor(minDimension * scanRatio);
                        
                        // 모바일에서 성능 고려한 다운스케일링 (품질 향상)
                        const downscaleRatio = isMobile ? 0.9 : 1.0;
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

            // 카메라 시작 및 상세 상태 확인
            this.addDebugLog('카메라 시작 중...');
            
            try {
                await this.scanner.start();
                
                // 카메라 시작 후 상세 정보 로깅
                const hasCamera = await QrScanner.hasCamera();
                this.addDebugLog(`카메라 사용 가능: ${hasCamera}`);
                
                // 카메라 목록 확인
                try {
                    const cameras = await QrScanner.listCameras(true);
                    this.addDebugLog(`사용 가능한 카메라: ${cameras.length}개`);
                    cameras.forEach((camera, index) => {
                        this.addDebugLog(`  ${index + 1}. ${camera.label} (${camera.id})`);
                    });
                } catch (e) {
                    this.addDebugLog(`카메라 목록 확인 실패: ${e.message}`);
                }
                
                // 플래시 지원 확인
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
            this.scanStartTime = Date.now(); // 스캔 시작 시간 기록
            
            document.getElementById('startScanBtn').classList.add('hidden');
            document.getElementById('stopScanBtn').classList.remove('hidden');
            
            // 스캔 상태 모니터링 시작
            this.startScanMonitoring();
            
            this.showStatus('카메라가 시작되었습니다. QR 코드를 스캔해주세요.', 'info');

        } catch (error) {
            this.addDebugLog(`스캐너 시작 실패: ${error.message}`);
            this.addDebugLog(`에러 스택: ${error.stack}`);
            
            this.showStatus('카메라 시작 실패: ' + error.message, 'error');
            
            // 대안 제시
            this.showAlternativeOptions();
        }
    }

    async stopScanner() {
        this.addDebugLog('카메라 스캐너 정지 중...');
        
        // cleanupScanner를 사용하여 완전한 정리
        await this.cleanupScanner();
        
        // UI 상태 업데이트
        document.getElementById('startScanBtn').classList.remove('hidden');
        document.getElementById('stopScanBtn').classList.add('hidden');
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
                    this.addDebugLog(`비디오 트랙 정지: ${track.kind}`);
                });
                video.srcObject = null;
                this.addDebugLog('비디오 엘리먼트 정리 완료');
            } catch (error) {
                this.addDebugLog(`비디오 엘리먼트 정리 오류: ${error.message}`);
            }
        }
    }

    async cleanupScanner() {
        this.addDebugLog('스캐너 완전 정리 시작');
        
        // 스캔 상태 플래그 설정
        this.isScanning = false;
        this.pauseScanning = false;
        
        // 모니터링 정지
        this.stopScanMonitoring();
        
        // 스캐너 인스턴스 정리
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
        
        // 비디오 엘리먼트 정리
        this.cleanupVideoElement();
        
        // 약간의 지연으로 완전한 정리 보장
        await new Promise(resolve => setTimeout(resolve, 100));
        
        this.addDebugLog('스캐너 완전 정리 완료');
    }



    async handleQRResult(result) {
        try {
            this.addDebugLog(`QR 결과 처리 시작: ${result}`);
            
            // 중복 스캔 방지 - 같은 QR 코드를 연속으로 스캔하지 않도록
            if (this.lastScannedQR === result) {
                this.addDebugLog('중복 QR 스캔 감지, 무시함');
                return;
            }
            this.lastScannedQR = result;
            
            // QR 결과가 문자열인지 확인
            if (typeof result !== 'string') {
                this.addDebugLog(`QR 결과를 문자열로 변환: ${result}`);
                result = result.toString();
            }
            
            this.addDebugLog('QR 데이터 파싱 시도');
            
            // QR 데이터 파싱
            const qrData = JSON.parse(result);
            
            // QR 코드 타입 확인 - 새로운 구조 처리
            if (qrData.type === 'wallet_info') {
                // 첫 번째 QR: 결제 사이트 접속용 (개인키 + 사이트 URL)
                this.addDebugLog('결제 사이트 접속용 QR 코드 처리 시작');
                
                // 개인키 저장
                this.walletPrivateKey = qrData.privateKey;
                this.firstQRScanned = true;
                
                // 결제 사이트 URL이 있으면 리다이렉트
                if (qrData.paymentSiteUrl) {
                    this.addDebugLog(`결제 사이트로 리다이렉트: ${qrData.paymentSiteUrl}`);
                    this.showStatus('결제 사이트로 이동 중...', 'info');
                    
                    // 개인키를 localStorage에 임시 저장 (결제 사이트에서 사용)
                    localStorage.setItem('temp_wallet_private_key', qrData.privateKey);
                    localStorage.setItem('temp_wallet_timestamp', qrData.timestamp.toString());
                    
                    // 잠시 후 리다이렉트
                    setTimeout(() => {
                        window.location.href = qrData.paymentSiteUrl;
                    }, 1000);
                    
                    return;
                }
                
                // paymentSiteUrl이 없으면 기존 방식으로 처리
                await this.handleWalletInfoQR(qrData);
                
            } else if (qrData.type === 'payment_request') {
                // 두 번째 QR: 직접 결제용 (개인키 포함, 독립적)
                this.addDebugLog('직접 결제용 QR 코드 처리 시작');
                
                // 개인키가 QR에 포함되어 있으므로 즉시 결제 가능
                if (qrData.privateKey) {
                    this.addDebugLog('독립적 결제 QR 감지 - 개인키 포함됨');
                    this.walletPrivateKey = qrData.privateKey;
                    this.firstQRScanned = true;
                }
                
                // 스캐너 중지하고 결제 실행
                await this.stopScanner();
                await this.handlePaymentRequestQR(qrData);
            } 
            // 아래는 기존 암호화 QR 코드 호환성을 위한 처리 (현재 사용 안함)
            else if (qrData.type === 'encrypted_private_key') {
                // 암호화된 개인키 QR (레거시 지원)
                this.addDebugLog('암호화된 개인키 QR 코드 처리 시작 - 스캐너 유지');
                await this.handlePrivateKeyQR(qrData);
            } else if (qrData.type === 'encrypted_payment_only') {
                // 암호화된 결제정보 QR (레거시 지원)
                this.addDebugLog('암호화된 결제정보 QR 코드 처리 시작 - 스캐너 중지');
                await this.stopScanner();
                await this.handlePaymentDataQR(qrData);
            } else if (qrData.type === 'encrypted_payment') {
                // 단일 암호화된 QR 코드 (레거시 지원)
                this.addDebugLog('단일 암호화된 QR 코드 처리 시작 - 스캐너 중지');
                await this.stopScanner();
                await this.handleEncryptedPayment(qrData);
            } else {
                // 알 수 없는 QR 타입 또는 기존 방식 (단일 QR 코드)
                this.addDebugLog('알 수 없는 QR 타입 또는 레거시 단일 QR - 스캐너 중지');
                await this.stopScanner();
                await this.handleDirectPayment(qrData);
            }
            
        } catch (error) {
            this.addDebugLog(`QR 데이터 파싱 실패: ${error.message}`);
            this.addDebugLog(`원본 QR 데이터: ${result}`);
            this.showStatus('유효하지 않은 QR 코드입니다: ' + error.message, 'error');
            
            // 에러 발생 시 스캔 재개 (첫 번째 QR이었을 경우를 대비)
            this.pauseScanning = false;
        }
    }

    // 첫 번째 QR: 지갑 정보 처리 (wallet_info 타입)
    async handleWalletInfoQR(walletData) {
        try {
            this.addDebugLog('지갑 정보 QR 데이터 처리 시작');
            this.addDebugLog(`- 개인키: ${walletData.privateKey ? '포함됨' : '없음'}`);
            this.addDebugLog(`- 생성 시간: ${new Date(walletData.timestamp).toLocaleString()}`);
            
            // 개인키 임시 저장
            this.walletPrivateKey = walletData.privateKey;
            
            // 첫 번째 QR 스캔 완료 플래그 설정
            this.firstQRScanned = true;
            
            // 잠시 스캔 일시정지 (중복 스캔 방지)
            this.pauseScanning = true;
            
            this.showStatus('지갑 정보 QR 코드를 스캔했습니다.', 'success');
            
            this.addDebugLog('지갑 정보 저장 성공');
            
            // 성공 메시지와 함께 스캔 재개 안내
            this.showStatus(`✅ 지갑 정보가 저장되었습니다!
            
🔴 이제 두 번째 QR 코드(결제정보)를 스캔해주세요.
📱 카메라가 자동으로 다시 시작됩니다.`, 'success');
            
            // 1초 후 스캔 재개 (사용자가 메시지를 읽을 시간 제공)
            setTimeout(() => {
                this.addDebugLog('첫 번째 QR 완료, 두 번째 QR 스캔 대기 중...');
                this.pauseScanning = false;
                
                // 스캔 가이드 텍스트 업데이트
                const scanGuide = document.querySelector('.scan-instruction');
                if (scanGuide) {
                    scanGuide.textContent = '두 번째 QR(결제정보)를 이 영역에 맞춰주세요';
                    scanGuide.style.color = '#e74c3c'; // 빨간색으로 강조
                }
                
                this.showStatus('두 번째 QR 코드(결제정보)를 스캔해주세요!', 'info');
            }, 1500);
            
        } catch (error) {
            this.addDebugLog(`지갑 정보 처리 실패: ${error.message}`);
            this.showStatus('지갑 정보 처리 실패: ' + error.message, 'error');
            
            // 에러 발생 시 스캔 재개
            this.pauseScanning = false;
        }
    }

    // 두 번째 QR: 결제 정보 처리 (payment_request 타입)
    async handlePaymentRequestQR(paymentData) {
        try {
            this.addDebugLog('💳 결제 정보 QR 데이터 처리 시작');
            this.addDebugLog(`- 금액: ${paymentData.amount}`);
            this.addDebugLog(`- 수신자: ${paymentData.recipient}`);
            this.addDebugLog(`- 토큰: ${paymentData.token}`);
            
            // 서버 URL 처리 - QR 코드에 없으면 환경변수 또는 기본값 사용
            const serverUrl = paymentData.serverUrl || 'https://ccd794063d7c.ngrok-free.app';
            this.addDebugLog(`- 서버 URL: ${serverUrl} ${paymentData.serverUrl ? '(QR에서)' : '(기본값)'}`);
            
            // 개인키 처리 - QR에 포함된 개인키 우선 사용
            let privateKey = this.walletPrivateKey;
            if (paymentData.privateKey) {
                this.addDebugLog('QR에 포함된 개인키 사용 (독립적 결제 모드)');
                privateKey = paymentData.privateKey;
                this.walletPrivateKey = privateKey; // 업데이트
            }
            
            // 개인키가 없으면 에러
            if (!privateKey) {
                throw new Error('개인키가 없습니다. 첫 번째 QR 코드(지갑 정보)를 먼저 스캔하거나 독립적 결제 QR을 사용해주세요.');
            }
            
            this.addDebugLog(`- 개인키: ${privateKey.substring(0, 10)}... ${paymentData.privateKey ? '(QR 포함)' : '(저장된 값)'}`);
            
            // 결제 데이터에 개인키와 서버 URL 추가
            this.paymentData = {
                ...paymentData,
                serverUrl: serverUrl,
                privateKey: privateKey
            };
            
            this.addDebugLog(`설정된 결제 데이터: ${JSON.stringify(this.paymentData)}`);
            this.addDebugLog(`- 최종 금액: ${this.paymentData.amount}`);
            this.addDebugLog(`- 최종 토큰: ${this.paymentData.token}`);
            this.addDebugLog(`- 최종 수신자: ${this.paymentData.recipient}`);
            
            // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentProcessing').classList.remove('hidden');
            
            this.showStatus('결제 정보 QR 코드를 스캔했습니다. 결제를 진행합니다...', 'success');
            
            // 바로 결제 실행
            this.executePayment();
            
        } catch (error) {
            this.addDebugLog(`결제 정보 처리 실패: ${error.message}`);
            this.showStatus('결제 정보 처리 실패: ' + error.message, 'error');
        }
    }

    // 첫 번째 QR: 개인키 처리
    async handlePrivateKeyQR(privateKeyData) {
        try {
            this.addDebugLog('🔑 개인키 QR 데이터 처리 시작');
            this.addDebugLog(`- 세션 ID: ${privateKeyData.sessionId}`);
            this.addDebugLog(`- 생성 시간: ${new Date(privateKeyData.timestamp).toLocaleString()}`);
            
            // 잠시 스캔 일시정지 (중복 스캔 방지)
            this.pauseScanning = true;
            
            this.showStatus('개인키 QR 코드를 스캔했습니다. 서버에서 안전하게 저장 중...', 'success');
            
            // 백엔드에 개인키 데이터 전송
            const response = await fetch('/crypto/scan-private-key', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(privateKeyData)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
                throw new Error(errorData.message || `HTTP ${response.status}`);
            }

            const result = await response.json();
            
            this.addDebugLog('개인키 저장 성공');
            
            // 성공 메시지와 함께 스캔 재개 안내
            this.showStatus(`개인키가 안전하게 저장되었습니다! (세션: ${result.sessionId.substring(0, 8)}...)
            
이제 두 번째 QR 코드(결제정보)를 스캔해주세요.
📱 카메라가 자동으로 다시 시작됩니다.`, 'success');
            
            // 1초 후 스캔 재개 (사용자가 메시지를 읽을 시간 제공)
            setTimeout(() => {
                this.addDebugLog('첫 번째 QR 완료, 두 번째 QR 스캔 대기 중...');
                this.pauseScanning = false;
                
                // 스캔 가이드 텍스트 업데이트
                const scanGuide = document.querySelector('.scan-instruction');
                if (scanGuide) {
                    scanGuide.textContent = '두 번째 QR(결제정보)를 이 영역에 맞춰주세요';
                    scanGuide.style.color = '#e74c3c'; // 빨간색으로 강조
                }
                
                this.showStatus('두 번째 QR 코드(결제정보)를 스캔해주세요!', 'info');
            }, 1500);
            
        } catch (error) {
            this.addDebugLog(`개인키 처리 실패: ${error.message}`);
            this.showStatus('개인키 처리 실패: ' + error.message, 'error');
            // 에러 발생 시 스캔 재개
            this.pauseScanning = false;
        }
    }

    // 두 번째 QR: 결제정보 처리
    async handlePaymentDataQR(paymentData) {
        try {
            this.addDebugLog('💳 결제정보 QR 데이터 처리 시작');
            this.addDebugLog(`- 세션 ID: ${paymentData.sessionId}`);
            this.addDebugLog(`- 생성 시간: ${new Date(paymentData.timestamp).toLocaleString()}`);
            
            // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentProcessing').classList.remove('hidden');
            
            this.showStatus('결제정보 QR 코드를 스캔했습니다. 개인키와 결합하여 결제를 진행합니다...', 'success');
            
            // 백엔드에 결제정보 데이터 전송
            await this.executePaymentDataProcessing(paymentData);
            
        } catch (error) {
            this.addDebugLog(`결제정보 처리 실패: ${error.message}`);
            this.showStatus('결제정보 처리 실패: ' + error.message, 'error');
        }
    }

    // 결제정보 처리 실행
    async executePaymentDataProcessing(paymentData) {
        try {
            // 결제 진행 상태 업데이트
            this.updatePaymentProgress('서버에서 개인키와 결제정보 결합 중...');
            
            // 백엔드의 결제정보 처리 API 호출
            const response = await fetch('/crypto/scan-payment-data', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(paymentData)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
                throw new Error(errorData.message || `HTTP ${response.status}`);
            }

            const result = await response.json();
            
            // 성공 처리
            this.handlePaymentSuccess(result);

        } catch (error) {
            console.error('결제정보 처리 실행 실패:', error);
            this.handlePaymentError(error);
        }
    }

    // 암호화된 QR 코드 결제 처리 (기존 단일 QR)
    async handleEncryptedPayment(encryptedData) {
        try {
            this.addDebugLog('🔐 암호화된 결제 데이터 처리 시작');
            this.addDebugLog(`- 암호화 데이터 크기: ${encryptedData.encryptedData.length}바이트`);
            this.addDebugLog(`- 생성 시간: ${new Date(encryptedData.timestamp).toLocaleString()}`);
            
            // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentProcessing').classList.remove('hidden');
            
            this.showStatus('암호화된 QR 코드를 스캔했습니다. 서버에서 복호화하여 결제를 진행합니다...', 'success');
            
            // 백엔드에 암호화된 결제 데이터 전송
            await this.executeEncryptedPayment(encryptedData);
            
        } catch (error) {
            this.addDebugLog(`암호화된 결제 처리 실패: ${error.message}`);
            this.showStatus('암호화된 결제 처리 실패: ' + error.message, 'error');
        }
    }



    // 기존 방식 결제 처리 (단일 QR)
    handleDirectPayment(paymentData) {
        this.addDebugLog('QR 데이터 파싱 성공');
        this.addDebugLog(`- 금액: ${paymentData.amount}`);
        this.addDebugLog(`- 수신자: ${paymentData.recipient}`);
        this.addDebugLog(`- 토큰: ${paymentData.token}`);
        
        this.paymentData = paymentData;
        
        // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
        document.getElementById('scannerSection').classList.add('hidden');
        document.getElementById('paymentProcessing').classList.remove('hidden');
        
        this.showStatus('QR 코드를 스캔했습니다. 결제를 진행합니다...', 'success');
        
        // 바로 결제 실행
        this.executePayment();
    }

    // 암호화된 결제 실행
    async executeEncryptedPayment(encryptedData) {
        try {
            // 결제 진행 상태 업데이트
            this.updatePaymentProgress('서버에서 암호화 데이터 복호화 중...');
            
            // 백엔드의 암호화 결제 API 호출
            const response = await fetch('/crypto/scan-payment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(encryptedData)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
                throw new Error(errorData.message || `HTTP ${response.status}`);
            }

            const result = await response.json();
            
            // 성공 처리
            this.handlePaymentSuccess(result);

        } catch (error) {
            console.error('암호화된 결제 실행 실패:', error);
            this.handlePaymentError(error);
        }
    }





    async executePayment() {
        if (!this.paymentData) {
            this.showStatus('결제 데이터가 없습니다.', 'error');
            return;
        }

        try {
            // 결제 진행 상태 업데이트
            this.updatePaymentProgress('서버에 결제 요청 중...');
            
            // 서버에 가스리스 결제 요청
            const result = await this.sendGaslessPayment();
            
            // 성공 처리
            this.handlePaymentSuccess(result);

        } catch (error) {
            console.error('결제 실행 실패:', error);
            this.handlePaymentError(error);
        }
    }

    async sendGaslessPayment() {
        this.addDebugLog('가스리스 결제 요청 준비 중...');
        
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

        this.addDebugLog(`서버로 전송할 데이터: ${JSON.stringify(requestBody)}`);
        this.addDebugLog(`요청 URL: ${this.paymentData.serverUrl}/gasless-payment`);

        const response = await fetch(`${this.paymentData.serverUrl}/gasless-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        this.addDebugLog(`서버 응답 상태: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            this.addDebugLog(`서버 에러 응답: ${JSON.stringify(errorData)}`);
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }

        const result = await response.json();
        this.addDebugLog(`서버 성공 응답: ${JSON.stringify(result)}`);
        return result;
    }

    handlePaymentSuccess(result) {
        this.addDebugLog('결제 성공 처리 시작');
        this.addDebugLog(`결제 결과: ${JSON.stringify(result)}`);
        
        // 결제 진행 섹션 숨기기
        document.getElementById('paymentProcessing').classList.add('hidden');
        
        // 결과 섹션 표시
        document.getElementById('resultSection').classList.remove('hidden');
        
        // 토큰 주소를 심볼로 변환하는 함수
        const getTokenSymbol = (tokenAddress) => {
            this.addDebugLog(`토큰 심볼 변환 시도: ${tokenAddress}`);
            
            const tokenSymbols = {
                '0x29756cc': 'USDT',
                '0xa0b86a33e6885a31c806e95ec8298630': 'USDC',
                '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
                '0xa0b86a33e6885a31c806e95e8c8298630': 'USDC'
            };
            
            if (!tokenAddress) {
                this.addDebugLog('토큰 주소가 없어 기본값 TOKEN 반환');
                return 'TOKEN';
            }
            
            // 정확한 매칭 시도
            const symbol = tokenSymbols[tokenAddress.toLowerCase()];
            if (symbol) {
                this.addDebugLog(`정확한 매칭 성공: ${symbol}`);
                return symbol;
            }
            
            // 부분 매칭 시도 (주소의 일부가 포함된 경우)
            for (const [addr, sym] of Object.entries(tokenSymbols)) {
                if (tokenAddress.toLowerCase().includes(addr.toLowerCase()) || 
                    addr.toLowerCase().includes(tokenAddress.toLowerCase())) {
                    this.addDebugLog(`부분 매칭 성공: ${sym}`);
                    return sym;
                }
            }
            
            this.addDebugLog('매칭 실패, 기본값 TOKEN 반환');
            return 'TOKEN';
        };
        
        // 금액과 토큰 정보 가져오기 (올바른 paymentData에서)
        this.addDebugLog(`결제 데이터 확인: ${JSON.stringify(this.paymentData)}`);
        
        const formatAmount = (amountWei) => {
            try {
                this.addDebugLog(`금액 변환 시도: ${amountWei}`);
                // Wei에서 Ether로 변환 (18 decimals)
                const ethAmount = Number(amountWei) / Math.pow(10, 18);
                const formatted = ethAmount.toFixed(6).replace(/\.?0+$/, ''); // 소수점 뒤 불필요한 0 제거
                this.addDebugLog(`금액 변환 결과: ${formatted}`);
                return formatted;
            } catch (e) {
                this.addDebugLog(`금액 변환 실패: ${e.message}, 원본 반환`);
                return amountWei; // 변환 실패시 원본 반환
            }
        };
        
        // 올바른 데이터 소스 사용: this.paymentData
        const amount = this.paymentData?.amount ? formatAmount(this.paymentData.amount) : 'N/A';
        const token = this.paymentData?.token || '';
        const tokenSymbol = getTokenSymbol(token);
        
        this.addDebugLog(`최종 표시될 금액: ${amount} ${tokenSymbol}`);
        
        const resultInfo = document.getElementById('resultInfo');
        resultInfo.innerHTML = `
            <div class="status success">
                <h3>결제 완료!</h3>
                <strong>거래 해시:</strong> <span style="word-break: break-all;">${result.txHash}</span><br>
                <strong>결제 금액:</strong> ${amount} ${tokenSymbol}<br>
                <strong>상태:</strong> ${result.status}<br>
                <strong>완료 시간:</strong> ${new Date().toLocaleString()}
            </div>
            <div class="status info mt-2">
                가스리스 결제가 성공적으로 완료되었습니다!<br>
                블록체인에서 거래가 확인될 때까지 잠시 기다려주세요.
            </div>
        `;
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
                <h3>결제 실패</h3>
                <strong>오류 내용:</strong> ${error.message}<br>
                <strong>실패 시간:</strong> ${new Date().toLocaleString()}
            </div>
            <div class="status info mt-2">
                결제 처리 중 오류가 발생했습니다.<br>
                다시 시도하거나 관리자에게 문의해주세요.
            </div>
        `;
        
        this.showStatus('결제 실행 실패: ' + error.message, 'error');
    }



    async resetScanner() {
        this.addDebugLog('스캐너 상태 초기화 시작');
        
        // 스캐너 완전 정지
        if (this.isScanning) {
            await this.stopScanner();
        }
        
        // 모든 섹션 초기화
        document.getElementById('scannerSection').classList.remove('hidden');
        document.getElementById('paymentProcessing').classList.add('hidden');
        document.getElementById('resultSection').classList.add('hidden');
        
        // 데이터 초기화
        this.paymentData = null;
        this.wallet = null;
        this.provider = null;
        this.scanAttempts = 0;
        this.lastScanTime = null;
        this.pauseScanning = false;
        this.walletPrivateKey = null;
        this.lastScannedQR = null;
        this.firstQRScanned = false;
        

        
        // 비디오 컨테이너 스타일 초기화
        const videoContainer = document.querySelector('.video-container');
        if (videoContainer) {
            videoContainer.style.transform = 'scale(1)';
        }
        
        this.addDebugLog('상태 초기화 완료');
        this.showStatus('새로운 QR 코드를 스캔할 준비가 되었습니다.', 'info');
    }



    shortenAddress(address) {
        if (!address) return '';
        // 거래 해시는 전체 표시, 주소만 축약
        if (address.length === 66 && address.startsWith('0x')) {
            // 거래 해시인 경우 전체 표시
            return address;
        }
        // 주소인 경우에만 축약
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    showAlternativeOptions() {
        // 카메라 스캔 실패 시 대안 옵션 제시
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
        
        // 최대 50개 로그만 유지
        if (this.debugLogs.length > 50) {
            this.debugLogs.shift();
        }
        
        // 콘솔에도 출력
        console.log(message);
    }



    startScanMonitoring() {
        // 간단한 상태 업데이트만 수행
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
        
        // 간단한 상태 표시 업데이트
        const statusEl = document.getElementById('status');
        if (statusEl && !statusEl.classList.contains('error')) {
            statusEl.className = 'status info';
            statusEl.innerHTML = 'QR 코드를 스캔하는 중입니다...';
            statusEl.classList.remove('hidden');
        }
    }
    
    showQRDetectedFeedback() {
        // QR 코드 감지 시 즉시 피드백
        const statusEl = document.getElementById('status');
        statusEl.className = 'status success';
        statusEl.innerHTML = 'QR 코드 감지! 데이터 처리 중...';
        statusEl.classList.remove('hidden');
        
        // 비프음 사운드 또는 진동 (지원되는 경우)
        if ('vibrate' in navigator) {
            navigator.vibrate(200);
        }
        
        this.addDebugLog('QR 코드 감지됨! 처리 시작');
    }

    showStatus(message, type) {
        const statusEl = document.getElementById('status');
        statusEl.className = `status ${type}`;
        statusEl.textContent = message;
        statusEl.classList.remove('hidden');

        // 디버깅 로그에도 추가
        this.addDebugLog(`상태 메시지 (${type}): ${message}`);

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
            this.addDebugLog('카메라 영역 터치 감지');
            
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
                this.addDebugLog('페이지 비활성화, 스캔 일시 중단');
                this.pauseScanning = true;
            }
        } else {
            // 페이지가 다시 활성화되면 스캔 재개
            if (this.isScanning && this.pauseScanning) {
                this.addDebugLog('페이지 재활성화, 스캔 재개');
                this.pauseScanning = false;
            }
        }
    }

    // 지갑 잔고 조회 및 표시
    async fetchAndDisplayBalance() {
        if (!this.walletPrivateKey) {
            this.addDebugLog('개인키가 없어 잔고를 조회할 수 없습니다.');
            return;
        }

        try {
            this.addDebugLog('서버에 잔고 조회 요청 중...');
            
            // 잔고 섹션 표시
            const balanceSection = document.getElementById('balanceSection');
            if (balanceSection) {
                balanceSection.classList.remove('hidden');
            }

            const response = await fetch('/api/wallet/balance', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    privateKey: this.walletPrivateKey
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
                throw new Error(errorData.message || `HTTP ${response.status}`);
            }

            const result = await response.json();
            this.addDebugLog('잔고 조회 성공');
            this.addDebugLog(`ETH: ${result.balance.ethBalance.formatted}`);
            this.addDebugLog(`${result.balance.tokenBalance.symbol}: ${result.balance.tokenBalance.formatted}`);

            // 잔고 정보 표시
            this.displayBalance(result.balance);
            
            // 상태 메시지 업데이트
            this.showStatus('지갑 잔고가 조회되었습니다. 이제 두 번째 QR 코드를 스캔해주세요!', 'success');

        } catch (error) {
            this.addDebugLog(`잔고 조회 실패: ${error.message}`);
            this.showStatus(`잔고 조회 실패: ${error.message}`, 'error');
            
            // 잔고 섹션 숨기기
            const balanceSection = document.getElementById('balanceSection');
            if (balanceSection) {
                balanceSection.classList.add('hidden');
            }
        }
    }

    // 잔고 정보 UI에 표시
    displayBalance(balance) {
        const balanceInfo = document.getElementById('balanceInfo');
        if (!balanceInfo) return;

        // 주소 축약 함수
        const shortenAddress = (address) => {
            if (!address) return '';
            return `${address.slice(0, 6)}...${address.slice(-4)}`;
        };

        balanceInfo.innerHTML = `
            <div class="balance-item">
                <span class="balance-label">지갑 주소:</span>
                <span class="balance-value">${shortenAddress(balance.address)}</span>
            </div>
            <div class="wallet-address">${balance.address}</div>
            <div class="balance-item">
                <span class="balance-label">ETH 잔액:</span>
                <span class="balance-value">${parseFloat(balance.ethBalance.formatted).toFixed(4)} ETH</span>
            </div>
            <div class="balance-item">
                <span class="balance-label">${balance.tokenBalance.symbol} 잔액:</span>
                <span class="balance-value">${parseFloat(balance.tokenBalance.formatted).toFixed(2)} ${balance.tokenBalance.symbol}</span>
            </div>
            <div class="balance-item">
                <span class="balance-label">네트워크:</span>
                <span class="balance-value">Chain ID ${balance.chainId}</span>
            </div>
            <div class="balance-item">
                <span class="balance-label">조회 시간:</span>
                <span class="balance-value">${new Date(balance.timestamp).toLocaleString()}</span>
            </div>
        `;
    }
}

// 페이지 로드 시 초기화
let paymentScannerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    paymentScannerInstance = new PaymentScanner();
});

// 페이지 떠나기 전 정리
window.addEventListener('beforeunload', async () => {
    if (paymentScannerInstance && paymentScannerInstance.isScanning) {
        await paymentScannerInstance.stopScanner();
    }
});

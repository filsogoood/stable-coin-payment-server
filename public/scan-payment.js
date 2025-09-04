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
        this.lastScannedTime = 0; // 마지막 QR 스캔 시간 (중복 방지용)
        this.firstQRScanned = false; // 첫 번째 QR 스캔 완료 여부
        this.serverConfig = null; // 서버에서 가져온 설정
        this.currentLang = sessionStorage.getItem('preferred_language') || 'ko'; // 언어 설정
        this.lastBalanceData = null; // 잔액 데이터 저장용
        this.init();
    }
    
    // 다국어 텍스트 가져오기 헬퍼 함수
    getI18nText(key) {
        const texts = window.scanPageI18n ? window.scanPageI18n[this.currentLang] : null;
        return texts ? texts[key] : key;
    }
    
    // 다국어 지원 showStatus 함수
    showLocalizedStatus(messageKey, type, fallbackMessage = null) {
        const message = this.getI18nText(messageKey) || fallbackMessage || messageKey;
        this.showStatus(message, type);
    }

    async init() {
        this.bindEvents();
        this.initializeEthers();
        await this.loadServerConfig();
        this.checkForStoredWalletInfo();
        
        // 초기화 후 개인키 상태 확인 및 로그
        this.logPrivateKeyStatus();
    }
    
    // 개인키 상태 로그 (디버깅용)
    logPrivateKeyStatus() {
        this.addDebugLog('📋 현재 개인키 상태 요약:');
        this.addDebugLog(`  - this.walletPrivateKey: ${this.walletPrivateKey ? '있음(' + this.walletPrivateKey.substring(0, 10) + '...)' : '없음'}`);
        this.addDebugLog(`  - this.firstQRScanned: ${this.firstQRScanned}`);
        this.addDebugLog(`  - sessionStorage wallet_private_key: ${sessionStorage.getItem('wallet_private_key') ? '있음' : '없음'}`);
        this.addDebugLog(`  - localStorage temp_wallet_private_key: ${localStorage.getItem('temp_wallet_private_key') ? '있음' : '없음'}`);
        this.addDebugLog(`  - URL pk 파라미터: ${new URLSearchParams(window.location.search).get('pk') ? '있음' : '없음'}`);
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
        
        this.addDebugLog('개인키 저장 상태 확인 시작');
        this.addDebugLog(`URL pk 파라미터: ${urlPrivateKey ? '있음' : '없음'}`);
        this.addDebugLog(`URL t 파라미터: ${urlTimestamp ? '있음' : '없음'}`);
        
        if (urlPrivateKey) {
            this.addDebugLog('URL 파라미터로 전달된 개인키 발견');
            this.addDebugLog(`- 개인키: ${urlPrivateKey.substring(0, 10)}...`);
            this.addDebugLog(`- 타임스탬프: ${urlTimestamp ? new Date(parseInt(urlTimestamp)).toLocaleString() : '없음'}`);
            
            // 개인키 설정
            this.walletPrivateKey = urlPrivateKey;
            this.firstQRScanned = true;
            
            // sessionStorage에 개인키 임시 저장 (페이지 전환 시 유지용)
            sessionStorage.setItem('wallet_private_key', urlPrivateKey);
            sessionStorage.setItem('wallet_timestamp', urlTimestamp || Date.now().toString());
            sessionStorage.setItem('first_qr_scanned', 'true');
            
            this.addDebugLog(`✅ 개인키 저장 완료 (메모리 + sessionStorage): ${this.walletPrivateKey.substring(0, 10)}...`);
            
            // URL에서 파라미터 제거 (보안상)
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
            
            // 조용한 잔고 조회 시작
            
            // 스캔 가이드 업데이트 - 다국어 지원
            const scanGuide = document.querySelector('.scan-instruction');
            if (scanGuide) {
                const texts = window.scanPageI18n ? window.scanPageI18n[this.currentLang] : null;
                scanGuide.textContent = texts ? texts.scan_payment_qr : '결제 QR 코드를 스캔해주세요';
                scanGuide.style.color = '#FFC107';
            }
            
            // 잔고 조회 비활성화
            // this.fetchAndDisplayBalance();
            
            return;
        }
        
        // sessionStorage에서 개인키 복구 시도 (새로운 방식)
        const sessionPrivateKey = sessionStorage.getItem('wallet_private_key');
        const sessionTimestamp = sessionStorage.getItem('wallet_timestamp');
        const sessionFirstQR = sessionStorage.getItem('first_qr_scanned');
        
        if (sessionPrivateKey) {
            this.addDebugLog('sessionStorage에서 개인키 발견');
            this.addDebugLog(`- 개인키: ${sessionPrivateKey.substring(0, 10)}...`);
            this.addDebugLog(`- 타임스탬프: ${sessionTimestamp ? new Date(parseInt(sessionTimestamp)).toLocaleString() : '없음'}`);
            this.addDebugLog(`- 첫QR스캔: ${sessionFirstQR}`);
            
            // 개인키 설정
            this.walletPrivateKey = sessionPrivateKey;
            this.firstQRScanned = sessionFirstQR === 'true';
            
            this.addDebugLog(`✅ sessionStorage에서 개인키 복구 완료: ${this.walletPrivateKey.substring(0, 10)}...`);
            
            // 스캔 가이드 업데이트 - 다국어 지원
            const scanGuide = document.querySelector('.scan-instruction');
            if (scanGuide) {
                const texts = window.scanPageI18n ? window.scanPageI18n[this.currentLang] : null;
                scanGuide.textContent = texts ? texts.scan_payment_qr : '결제 QR 코드를 스캔해주세요';
                scanGuide.style.color = '#FFC107';
            }
            
            // 잔고 조회 비활성화
            // this.fetchAndDisplayBalance();
            
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
            
            // sessionStorage로 이전 (새로운 방식으로 통일)
            sessionStorage.setItem('wallet_private_key', storedPrivateKey);
            sessionStorage.setItem('wallet_timestamp', storedTimestamp || Date.now().toString());
            sessionStorage.setItem('first_qr_scanned', 'true');
            
            // 임시 저장된 데이터 정리
            localStorage.removeItem('temp_wallet_private_key');
            localStorage.removeItem('temp_wallet_timestamp');
            
            // 조용한 잔고 조회 시작
            
            // 스캔 가이드 업데이트 - 다국어 지원
            const scanGuide = document.querySelector('.scan-instruction');
            if (scanGuide) {
                const texts = window.scanPageI18n ? window.scanPageI18n[this.currentLang] : null;
                scanGuide.textContent = texts ? texts.scan_payment_qr : '결제 QR 코드를 스캔해주세요';
                scanGuide.style.color = '#FFC107';
            }
            
            // 잔고 조회 비활성화
            // this.fetchAndDisplayBalance();
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
            return;
        }
        
        if (!ethersStatus) {
            this.addDebugLog('Ethers.js 라이브러리 로드 실패');
            return;
        }
        
        // 라이브러리 로드 완료 - 사용자 안내 메시지 제거
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
            
            // 브라우저 환경 상세 확인
            this.addDebugLog(`현재 URL: ${window.location.href}`);
            this.addDebugLog(`프로토콜: ${window.location.protocol}`);
            this.addDebugLog(`보안 컨텍스트: ${window.isSecureContext}`);
            this.addDebugLog(`User Agent: ${navigator.userAgent}`);
            
            // 모바일 기기 감지 (전체 함수에서 사용)
            const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            this.addDebugLog(`모바일 기기 감지: ${isMobile}`);
            
            // MediaDevices API 상세 확인
            this.addDebugLog(`navigator.mediaDevices 존재: ${!!navigator.mediaDevices}`);
            this.addDebugLog(`getUserMedia 함수 존재: ${!!navigator.mediaDevices?.getUserMedia}`);
            this.addDebugLog(`MediaDevices 프로토타입 확인: ${Object.prototype.toString.call(navigator.mediaDevices)}`);
            
            // 기본 지원 확인
            if (!navigator.mediaDevices?.getUserMedia) {
                const errorMsg = window.location.protocol === 'http:' && window.location.hostname !== 'localhost' 
                    ? '카메라 접근을 위해서는 HTTPS 연결이 필요합니다. HTTP에서는 카메라를 사용할 수 없습니다.'
                    : '카메라가 지원되지 않는 브라우저입니다.';
                this.addDebugLog(`카메라 지원 실패 원인: ${errorMsg}`);
                throw new Error(errorMsg);
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
            
            // 권한 API 지원 확인
            if (navigator.permissions) {
                try {
                    const permission = await navigator.permissions.query({ name: 'camera' });
                    this.addDebugLog(`카메라 권한 상태: ${permission.state}`);
                } catch (permErr) {
                    this.addDebugLog(`권한 상태 확인 실패: ${permErr.message}`);
                }
            } else {
                this.addDebugLog('Permissions API 지원되지 않음');
            }
            
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
                
                this.addDebugLog(`카메라 제약 조건: ${JSON.stringify(constraints.video, null, 2)}`);
                
                this.addDebugLog('getUserMedia 호출 시작...');
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                
                this.addDebugLog(`스트림 획득 성공 - 트랙 개수: ${stream.getTracks().length}`);
                stream.getTracks().forEach((track, index) => {
                    this.addDebugLog(`트랙 ${index}: ${track.kind} - ${track.label} (상태: ${track.readyState})`);
                });
                
                // 임시 스트림 정지 (권한 확인용)
                stream.getTracks().forEach(track => track.stop());
                this.addDebugLog('카메라 권한 확인 성공');
                
            } catch (permError) {
                this.addDebugLog(`카메라 접근 실패 상세 정보:`);
                this.addDebugLog(`- 에러 이름: ${permError.name}`);
                this.addDebugLog(`- 에러 메시지: ${permError.message}`);
                this.addDebugLog(`- 에러 코드: ${permError.code || '없음'}`);
                this.addDebugLog(`- 에러 스택: ${permError.stack}`);
                
                let userFriendlyMessage = '';
                switch(permError.name) {
                    case 'NotAllowedError':
                        userFriendlyMessage = '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라 권한을 허용해주세요.';
                        break;
                    case 'NotFoundError':
                        userFriendlyMessage = '카메라를 찾을 수 없습니다. 기기에 카메라가 연결되어 있는지 확인해주세요.';
                        break;
                    case 'NotReadableError':
                        userFriendlyMessage = '카메라가 다른 프로그램에서 사용 중입니다. 다른 앱을 종료하고 다시 시도해주세요.';
                        break;
                    case 'OverconstrainedError':
                        userFriendlyMessage = '요청된 카메라 설정을 지원하지 않습니다. 다시 시도해주세요.';
                        break;
                    case 'SecurityError':
                        userFriendlyMessage = '보안상의 이유로 카메라에 접근할 수 없습니다. HTTPS 연결이 필요할 수 있습니다.';
                        break;
                    case 'TypeError':
                        userFriendlyMessage = '카메라 설정이 잘못되었습니다.';
                        break;
                    default:
                        userFriendlyMessage = `카메라 접근 실패: ${permError.message}`;
                }
                
                this.addDebugLog(`사용자 친화적 메시지: ${userFriendlyMessage}`);
                throw new Error(userFriendlyMessage);
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
            
            this.showLocalizedStatus('camera_started', 'info');

        } catch (error) {
            this.addDebugLog(`스캐너 시작 실패: ${error.message}`);
            this.addDebugLog(`에러 스택: ${error.stack}`);
            
            const errorMessage = this.getI18nText('scanner_init_failed') + ': ' + error.message;
            this.showStatus(errorMessage, 'error');
            
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
        this.showLocalizedStatus('camera_stopped', 'info');
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
            
            // 중복 스캔 방지 - 시간 기반으로 개선 (3초 이내 같은 QR 코드는 무시)
            const currentTime = Date.now();
            const timeSinceLastScan = currentTime - this.lastScannedTime;
            
            if (this.lastScannedQR === result && timeSinceLastScan < 3000) {
                this.addDebugLog(`중복 QR 스캔 감지 (${timeSinceLastScan}ms 전), 무시함`);
                return;
            }
            
            // 새로운 QR 또는 충분한 시간이 지난 경우 스캔 허용
            this.lastScannedQR = result;
            this.lastScannedTime = currentTime;
            
            // QR 결과가 문자열인지 확인
            if (typeof result !== 'string') {
                this.addDebugLog(`QR 결과를 문자열로 변환: ${result}`);
                result = result.toString();
            }
            
            this.addDebugLog('QR 데이터 형식 확인 시작');
            
            // URL 형태의 첫번째 QR 코드인지 확인
            if (result.includes('?pk=') && (result.startsWith('http://') || result.startsWith('https://'))) {
                this.addDebugLog('URL 형태의 첫번째 QR 코드 감지');
                await this.handleWalletAccessUrl(result);
                return;
            }
            
            // JSON 형태의 QR 코드 파싱 시도
            let qrData;
            try {
                qrData = JSON.parse(result);
                this.addDebugLog('JSON QR 데이터 파싱 성공');
                this.addDebugLog(`파싱된 QR 데이터: ${JSON.stringify(qrData)}`);
                this.addDebugLog(`QR 데이터 상품명 확인: ${qrData.productName}`);
            } catch (parseError) {
                this.addDebugLog(`JSON 파싱 실패: ${parseError.message}`);
                throw new Error(this.getI18nText('invalid_qr_code'));
            }
            
            // QR 코드 타입 확인 - 새로운 구조 처리
            this.addDebugLog(`🔍 QR 타입 확인: ${qrData.type || 'type 없음'}`);
            this.addDebugLog(`🔍 QR 전체 데이터: ${JSON.stringify(qrData)}`);
            
            if (qrData.type === 'wallet_info') {
                // 첫 번째 QR: 결제 사이트 접속용 (개인키 + 사이트 URL)
                this.addDebugLog('🔑 결제 사이트 접속용 QR 코드 처리 시작');
                
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
                this.addDebugLog('💳 직접 결제용 QR 코드 처리 시작');
                this.addDebugLog(`💳 DEBUG: 현재 저장된 walletPrivateKey 상태: ${this.walletPrivateKey ? '있음' : '없음'}`);
                this.addDebugLog(`💳 DEBUG: QR에 개인키 포함 여부: ${qrData.privateKey ? '있음' : '없음'}`);
                this.addDebugLog(`💳 DEBUG: firstQRScanned 상태: ${this.firstQRScanned}`);
                
                // 개인키가 QR에 포함되어 있으면 사용, 없으면 저장된 개인키 사용
                if (qrData.privateKey) {
                    this.addDebugLog('독립적 결제 QR 감지 - 개인키 포함됨');
                    this.walletPrivateKey = qrData.privateKey;
                    this.firstQRScanned = true;
                } else if (this.walletPrivateKey) {
                    this.addDebugLog('독립적 결제 QR 감지 - 저장된 개인키 사용');
                    this.firstQRScanned = true;
                        } else {
            this.addDebugLog('⚠️ 독립적 결제 QR이지만 개인키가 없습니다');
            this.addDebugLog('⚠️ 개인키 상태 재확인:');
            this.addDebugLog(`  - this.walletPrivateKey: ${this.walletPrivateKey || '없음'}`);
            this.addDebugLog(`  - this.firstQRScanned: ${this.firstQRScanned}`);
            this.addDebugLog(`  - URL 파라미터 재확인: pk=${new URLSearchParams(window.location.search).get('pk') || '없음'}`);
            
            // 통합 개인키 복구 시도
            if (this.recoverPrivateKey()) {
                this.addDebugLog(`✅ 개인키 복구 성공! 결제 처리 계속 진행`);
                // 복구 성공 시 결제 처리 계속 진행하지 않고 다시 이 함수 호출
                await this.handlePaymentRequestQR(qrData);
                return;
            }
            
            this.showStatus('개인키가 없습니다. 개인키 접속용 QR을 먼저 스캔해주세요.', 'error');
            
            // 중복 방지 데이터 초기화 (다른 QR 스캔 허용)
            this.clearDuplicatePreventionData();
            return; // 에러 던지지 말고 리턴해서 스캔 계속 가능하게
        }
                
                this.addDebugLog('💳 결제 QR 처리 - 스캐너 중지 시작');
                // 스캐너 중지하고 결제 실행
                await this.stopScanner();
                this.addDebugLog('💳 결제 QR 처리 - 스캐너 중지 완료, handlePaymentRequestQR 호출');
                await this.handlePaymentRequestQR(qrData);
                this.addDebugLog('💳 결제 QR 처리 - handlePaymentRequestQR 완료');
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
            const errorMessage = this.getI18nText('invalid_qr_code') + ': ' + error.message;
            this.showStatus(errorMessage, 'error');
            
            // 에러 발생 시 스캔 재개 (첫 번째 QR이었을 경우를 대비)
            this.pauseScanning = false;
            
            // 에러 발생 시에도 중복 방지 데이터 초기화 (다음 QR 스캔 허용)
            this.clearDuplicatePreventionData();
        }
    }

    // URL 형태의 첫번째 QR 코드 처리 (pk 파라미터 포함)
    async handleWalletAccessUrl(url) {
        this.addDebugLog(`URL 형태 QR 처리: ${url}`);
        
        try {
            // URL에서 파라미터 추출
            const urlObj = new URL(url);
            const privateKey = urlObj.searchParams.get('pk');
            const timestamp = urlObj.searchParams.get('t');
            
            if (!privateKey) {
                throw new Error('개인키 파라미터(pk)가 없습니다');
            }
            
            this.addDebugLog('URL에서 개인키 추출 성공');
            this.addDebugLog(`- 개인키: ${privateKey.substring(0, 10)}...`);
            this.addDebugLog(`- 타임스탬프: ${timestamp ? new Date(parseInt(timestamp)).toLocaleString() : '없음'}`);
            
            // 개인키 설정 및 첫번째 QR 스캔 완료 표시
            this.walletPrivateKey = privateKey;
            this.firstQRScanned = true;
            
            // 스캐너 중지 (잔액 표시 후 다시 시작)
            await this.stopScanner();
            
            // 조용한 잔고 조회 시작
            
            // 스캔 가이드 업데이트 - 다국어 지원
            const scanGuide = document.querySelector('.scan-instruction');
            if (scanGuide) {
                const texts = window.scanPageI18n ? window.scanPageI18n[this.currentLang] : null;
                scanGuide.textContent = texts ? texts.scan_payment_qr : '결제 QR 코드를 스캔해주세요';
                scanGuide.style.color = '#FFC107';
            }
            
            // 잔고 조회 및 표시 비활성화
            // await this.fetchAndDisplayBalance();
            
            // 조용한 잔고 조회 완료
            
            // 스캐너 재시작 (두 번째 QR 코드 스캔을 위해)
            setTimeout(async () => {
                await this.startScanner();
            }, 2000);
            
            // 첫 번째 QR 처리 완료 후 중복 방지 데이터 초기화
            this.clearDuplicatePreventionData();
            
        } catch (error) {
            this.addDebugLog(`URL QR 처리 실패: ${error.message}`);
            this.showStatus(`첫 번째 QR 코드 처리 실패: ${error.message}`, 'error');
            
            // 실패 시 스캔 재개
            this.pauseScanning = false;
            
            // 에러 발생 시에도 중복 방지 데이터 초기화
            this.clearDuplicatePreventionData();
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
            
            this.showLocalizedStatus('wallet_info_scanned', 'success');
            
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
            this.addDebugLog(`- 상품명 디버깅:`);
            this.addDebugLog(`  - paymentData.productName: ${paymentData.productName}`);
            this.addDebugLog(`  - paymentData.product: ${paymentData.product}`);
            this.addDebugLog(`  - paymentData.item: ${paymentData.item}`);
            this.addDebugLog(`  - paymentData.name: ${paymentData.name}`);
            this.addDebugLog(`- 최종 상품명: ${paymentData.productName || paymentData.product || '상품명 없음'}`);
            this.addDebugLog(`- 전체 QR 데이터: ${JSON.stringify(paymentData)}`);
            
            // 서버 URL 처리 - QR 코드에 없으면 환경변수 또는 기본값 사용
            const serverUrl = paymentData.serverUrl;
            this.addDebugLog(`- 서버 URL: ${serverUrl} ${paymentData.serverUrl ? '(QR에서)' : '(기본값)'}`);
            
            // 개인키 처리 - 저장된 개인키 사용 (QR에는 개인키 없음)
            let privateKey = this.walletPrivateKey;
            this.addDebugLog(`🔍 DEBUG: 저장된 this.walletPrivateKey: ${this.walletPrivateKey?.substring(0, 10)}...`);
            this.addDebugLog(`🔍 DEBUG: QR의 paymentData.privateKey: ${paymentData.privateKey?.substring(0, 10) || '없음'}...`);
            
            // QR에 개인키가 포함된 경우 (독립적 결제 모드 - 이전 호환성)
            if (paymentData.privateKey) {
                this.addDebugLog('QR에 포함된 개인키 사용 (독립적 결제 모드)');
                privateKey = paymentData.privateKey;
                this.walletPrivateKey = privateKey; // 업데이트
            }
            
            // 개인키가 없으면 에러
            if (!privateKey) {
                throw new Error('개인키가 없습니다. 첫 번째 QR 코드(개인키 접속용)를 먼저 스캔해주세요.');
            }
            
            this.addDebugLog(`🔍 DEBUG: 최종 선택된 개인키: ${privateKey?.substring(0, 10)}... ${paymentData.privateKey ? '(QR 포함)' : '(저장된 개인키)'}`);
            
            // 결제 데이터에 개인키와 서버 URL 추가
            this.paymentData = {
                ...paymentData,
                serverUrl: serverUrl,
                privateKey: privateKey // 저장된 개인키 또는 QR 개인키
            };
            
            this.addDebugLog(`설정된 결제 데이터: ${JSON.stringify(this.paymentData)}`);
            this.addDebugLog(`- 최종 금액: ${this.paymentData.amount}`);
            this.addDebugLog(`- 최종 토큰: ${this.paymentData.token}`);
            this.addDebugLog(`- 최종 수신자: ${this.paymentData.recipient}`);
            
            // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentProcessing').classList.remove('hidden');
            
            this.showLocalizedStatus('payment_info_scanned', 'success');
            
            // 바로 결제 실행
            this.executePayment();
            
            // QR 처리 완료 후 중복 방지 데이터 초기화
            this.clearDuplicatePreventionData();
            
        } catch (error) {
            this.addDebugLog(`결제 정보 처리 실패: ${error.message}`);
            this.showStatus('결제 정보 처리 실패: ' + error.message, 'error');
            
            // 에러 발생 시에도 중복 방지 데이터 초기화
            this.clearDuplicatePreventionData();
        }
    }

    // 중복 방지 데이터 초기화 함수
    clearDuplicatePreventionData() {
        this.addDebugLog('중복 방지 데이터 초기화');
        this.lastScannedQR = null;
        this.lastScannedTime = 0;
    }
    
    // 개인키 복구 함수 (필요시 언제든 호출 가능)
    recoverPrivateKey() {
        this.addDebugLog('🔄 개인키 복구 시도 시작');
        
        // 1. 이미 개인키가 있으면 복구 불필요
        if (this.walletPrivateKey) {
            this.addDebugLog('✅ 개인키가 이미 있음, 복구 불필요');
            return true;
        }
        
        // 2. sessionStorage에서 복구 시도
        const sessionPrivateKey = sessionStorage.getItem('wallet_private_key');
        const sessionFirstQR = sessionStorage.getItem('first_qr_scanned');
        
        if (sessionPrivateKey) {
            this.addDebugLog(`🔄 sessionStorage에서 개인키 복구: ${sessionPrivateKey.substring(0, 10)}...`);
            this.walletPrivateKey = sessionPrivateKey;
            this.firstQRScanned = sessionFirstQR === 'true';
            return true;
        }
        
        // 3. URL 파라미터에서 복구 시도 (혹시 모름)
        const urlParams = new URLSearchParams(window.location.search);
        const urlPrivateKey = urlParams.get('pk');
        
        if (urlPrivateKey) {
            this.addDebugLog(`🔄 URL 파라미터에서 개인키 복구: ${urlPrivateKey.substring(0, 10)}...`);
            this.walletPrivateKey = urlPrivateKey;
            this.firstQRScanned = true;
            
            // sessionStorage에도 저장
            sessionStorage.setItem('wallet_private_key', urlPrivateKey);
            sessionStorage.setItem('first_qr_scanned', 'true');
            
            return true;
        }
        
        // 4. localStorage에서 복구 시도 (레거시)
        const storedPrivateKey = localStorage.getItem('temp_wallet_private_key');
        
        if (storedPrivateKey) {
            this.addDebugLog(`🔄 localStorage에서 개인키 복구: ${storedPrivateKey.substring(0, 10)}...`);
            this.walletPrivateKey = storedPrivateKey;
            this.firstQRScanned = true;
            
            // sessionStorage로 이전
            sessionStorage.setItem('wallet_private_key', storedPrivateKey);
            sessionStorage.setItem('first_qr_scanned', 'true');
            
            // localStorage 정리
            localStorage.removeItem('temp_wallet_private_key');
            localStorage.removeItem('temp_wallet_timestamp');
            
            return true;
        }
        
        this.addDebugLog('❌ 개인키 복구 실패 - 모든 저장소에서 개인키를 찾을 수 없음');
        return false;
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
            this.updatePaymentProgress(this.getI18nText('combining_keys'));
            
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
            this.addDebugLog(' 암호화된 결제 데이터 처리 시작');
            this.addDebugLog(`- 암호화 데이터 크기: ${encryptedData.encryptedData.length}바이트`);
            this.addDebugLog(`- 생성 시간: ${new Date(encryptedData.timestamp).toLocaleString()}`);
            
            // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
            document.getElementById('scannerSection').classList.add('hidden');
            document.getElementById('paymentProcessing').classList.remove('hidden');
            
            this.showStatus('암호화된 QR 코드를 스캔했습니다. 서버에서 복호화하여 결제를 진행합니다...', 'success');
            
            // 백엔드에 암호화된 결제 데이터 전송
            await this.executeEncryptedPayment(encryptedData);
            
            // QR 처리 완료 후 중복 방지 데이터 초기화
            this.clearDuplicatePreventionData();
            
        } catch (error) {
            this.addDebugLog(`암호화된 결제 처리 실패: ${error.message}`);
            this.showStatus('암호화된 결제 처리 실패: ' + error.message, 'error');
            
            // 에러 발생 시에도 중복 방지 데이터 초기화
            this.clearDuplicatePreventionData();
        }
    }



    // 기존 방식 결제 처리 (단일 QR)
    handleDirectPayment(paymentData) {
        this.addDebugLog('📱 기존 방식 QR 데이터 파싱 성공');
        this.addDebugLog(`- 금액: ${paymentData.amount}`);
        this.addDebugLog(`- 수신자: ${paymentData.recipient}`);
        this.addDebugLog(`- 토큰: ${paymentData.token}`);
        this.addDebugLog(`- 상품명: ${paymentData.productName || paymentData.product || '상품명 없음'}`);
        this.addDebugLog(`- 전체 QR 데이터: ${JSON.stringify(paymentData)}`);
        
        this.paymentData = paymentData;
        
        // 섹션 전환 - 스캔 섹션 숨기고 결제 진행 표시
        document.getElementById('scannerSection').classList.add('hidden');
        document.getElementById('paymentProcessing').classList.remove('hidden');
        
        this.showStatus(this.getI18nText('qr_scan_success') + '. ' + this.getI18nText('processing_payment'), 'success');
        
        // 바로 결제 실행
        this.executePayment();
        
        // QR 처리 완료 후 중복 방지 데이터 초기화
        this.clearDuplicatePreventionData();
    }

    // 암호화된 결제 실행
    async executeEncryptedPayment(encryptedData) {
        try {
            // 결제 진행 상태 업데이트
            this.updatePaymentProgress(this.getI18nText('decrypting_data'));
            
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
        
        // 결제 실행 전 개인키 최종 확인 및 복구 시도
        if (!this.walletPrivateKey) {
            this.addDebugLog('💳 결제 실행 직전 개인키 없음 - 복구 시도');
            if (!this.recoverPrivateKey()) {
                this.showStatus('개인키를 찾을 수 없습니다. 개인키 접속용 QR을 먼저 스캔해주세요.', 'error');
                return;
            }
            this.addDebugLog('💳 결제 실행 직전 개인키 복구 성공');
        }

        try {
            // 1. 사용자 측에서 서명 생성
            this.updatePaymentProgress(this.getI18nText('generating_signature'));
            const signatures = await this.generateSignatures();
            
            // 2. 서명과 공개키만 서버에 전송
            this.updatePaymentProgress(this.getI18nText('verifying_signature'));
            const result = await this.sendSignedPayment(signatures);
            
            // 성공 처리
            this.handlePaymentSuccess(result);

        } catch (error) {
            console.error('결제 실행 실패:', error);
            this.handlePaymentError(error);
        }
    }

    async generateSignatures() {
        this.addDebugLog('사용자 측 서명 생성 시작');
        
        // QR에서 받은 데이터
        const {
            chainId,
            delegateAddress,  // delegation target contract address
            privateKey
        } = this.paymentData;
        
        this.addDebugLog(`서명 데이터: chainId=${chainId}, delegateAddress=${delegateAddress}`);
        this.addDebugLog(`🔍 DEBUG: 실제 사용될 개인키: ${privateKey?.substring(0, 10)}...`);
        this.addDebugLog(`🔍 DEBUG: this.walletPrivateKey: ${this.walletPrivateKey?.substring(0, 10)}...`);
        this.addDebugLog(`🔍 DEBUG: paymentData 전체: ${JSON.stringify(this.paymentData)}`);
        
        // 기존 개인키로 wallet 객체 생성 (새로운 지갑이 아님)
        const wallet = new window.ethers.Wallet(privateKey);
        const authority = wallet.address; // 사용자 EOA 주소
        
        this.addDebugLog(`🔍 DEBUG: 생성된 authority 주소: ${authority}`);
        
        this.addDebugLog(`Authority EOA: ${authority}`);
        this.addDebugLog(`Delegation target: ${delegateAddress}`);
        
        // EOA nonce 가져오기 (서버에서 조회)
        const nonce = await this.getEOANonce(authority);
        
        // 1. EIP-7702 Authorization 서명 생성
        const authSignature = await this.generateEIP7702Authorization(wallet, chainId, delegateAddress, nonce);
        
        // 2. EIP-712 Transfer 서명을 위한 데이터 준비
        const transferData = await this.prepareTransferData(authority);
        
        // 3. EIP-712 Transfer 서명 생성  
        const transferSignature = await this.generateEIP712Transfer(wallet, chainId, authority, transferData);
        
        return {
            authority: authority,
            authSignature: authSignature,
            transferSignature: transferSignature,
            publicKey: wallet.signingKey.publicKey
        };
    }

    async getEOANonce(authority) {
        this.addDebugLog('EOA nonce 조회 시작');
        
        const response = await fetch(`${this.paymentData.serverUrl}/api/eoa-nonce`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ authority })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error('EOA nonce 조회 실패: ' + (errorData.message || 'Unknown error'));
        }
        
        const result = await response.json();
        this.addDebugLog(`EOA nonce: ${result.nonce}`);
        return result.nonce;
    }

    async generateEIP7702Authorization(wallet, chainId, delegateAddress, nonce) {
        this.addDebugLog('EIP-7702 Authorization 서명 생성 시작');
        
        // ethers.js signer.authorize() 메서드 사용
        const auth = await wallet.authorize({
            address: delegateAddress,
            nonce: nonce,
            chainId: chainId,
        });
        
        this.addDebugLog(`EIP-7702 서명 완료: ${auth.signature}`);
        
        return {
            chainId: Number(auth.chainId),           // BigInt → number
            address: auth.address,                   // delegation target
            nonce: Number(auth.nonce),               // BigInt → number
            signature: auth.signature.serialized    // Signature 객체를 문자열로 변환
        };
    }

    async prepareTransferData(authority) {
        this.addDebugLog('Transfer 데이터 준비 시작');
        
        // 서버에서 contract nonce와 transfer 데이터 조회
        const response = await fetch(`${this.paymentData.serverUrl}/api/prepare-transfer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                authority,
                token: this.paymentData.token,
                to: this.paymentData.recipient,
                amount: this.paymentData.amount
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error('Transfer 데이터 준비 실패: ' + (errorData.message || 'Unknown error'));
        }
        
        const result = await response.json();
        this.addDebugLog(`Transfer 데이터 준비 완료: ${JSON.stringify(result)}`);
        return result;
    }

    async generateEIP712Transfer(wallet, chainId, authority, transferData) {
        this.addDebugLog('EIP-712 Transfer 서명 생성 시작');
        
        // EIP-712 도메인
        const domain = {
            name: 'DelegatedTransfer',
            version: '1',
            chainId: chainId,
            verifyingContract: authority  // EOA 자체
        };
        
        // EIP-712 타입
        const types = {
            Transfer: [
                { name: 'from',     type: 'address' },
                { name: 'token',    type: 'address' },
                { name: 'to',       type: 'address' },
                { name: 'amount',   type: 'uint256' },
                { name: 'nonce',    type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
            ]
        };
        
        // Transfer 데이터 (서명용 - BigInt로 변환)
        const transfer = {
            from: authority,
            token: this.paymentData.token,
            to: this.paymentData.recipient,
            amount: BigInt(this.paymentData.amount),
            nonce: BigInt(transferData.nonce),
            deadline: BigInt(transferData.deadline)
        };
        
        // EIP-712 서명
        const signature = await wallet.signTypedData(domain, types, transfer);
        
        this.addDebugLog(`EIP-712 서명 완료: ${signature}`);
        
        return {
            domain: domain,
            types: types,
            transfer: {
                from: transfer.from,
                token: transfer.token,
                to: transfer.to,
                amount: transfer.amount.toString(),      // BigInt → string
                nonce: transfer.nonce.toString(),        // BigInt → string  
                deadline: transfer.deadline.toString()   // BigInt → string
            },
            signature: signature
        };
    }

    async sendSignedPayment(signatures) {
        this.addDebugLog('서명된 결제 데이터 전송 시작');
        this.addDebugLog(`전송할 서명 데이터: ${JSON.stringify({
            authority: signatures.authority,
            hasAuthorization: !!signatures.authSignature,
            hasTransfer: !!signatures.transferSignature,
            publicKey: signatures.publicKey?.substring(0, 20) + '...'
        })}`);
        
        // 상품명 정보 추가
        const productName = this.paymentData?.productName || 
                           this.paymentData?.product || 
                           this.paymentData?.item || 
                           this.paymentData?.name;
        
        this.addDebugLog(`서버 전송 전 상품명 확인 상세:`);
        this.addDebugLog(`  - this.paymentData?.productName: ${this.paymentData?.productName}`);
        this.addDebugLog(`  - this.paymentData?.product: ${this.paymentData?.product}`);
        this.addDebugLog(`  - this.paymentData?.item: ${this.paymentData?.item}`);
        this.addDebugLog(`  - this.paymentData?.name: ${this.paymentData?.name}`);
        this.addDebugLog(`  - 최종 productName: ${productName || '상품명 없음'}`);
        this.addDebugLog(`  - this.paymentData 전체: ${JSON.stringify(this.paymentData)}`);
        
        const requestData = {
            authority: signatures.authority,
            authorization: signatures.authSignature,
            transfer: signatures.transferSignature,
            publicKey: signatures.publicKey
        };
        
        // 상품명이 있으면 추가
        if (productName) {
            requestData.productName = productName;
            this.addDebugLog(`✅ 서버로 상품명 전송: ${productName}`);
        } else {
            this.addDebugLog('⚠️ 서버로 전송할 상품명이 없음');
        }
        
        this.addDebugLog(`서버 전송 데이터: ${JSON.stringify(requestData)}`);
        
        const response = await fetch(`${this.paymentData.serverUrl}/payment-signed`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestData)
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
            
            // 모든 토큰을 TUSD로 통일
            this.addDebugLog('모든 토큰을 TUSD로 표시');
            return 'TUSD';
        };
        
        // 금액과 토큰 정보 가져오기 (올바른 paymentData에서)
        this.addDebugLog(`결제 데이터 확인: ${JSON.stringify(this.paymentData)}`);
        
        const formatAmount = (amountWei) => {
            try {
                this.addDebugLog(`금액 변환 시도: ${amountWei}`);
                // Wei에서 Ether로 변환 (18 decimals)
                const ethAmount = Number(amountWei) / Math.pow(10, 18);
                // 반올림 대신 정확한 값 표시 (소수점 6자리까지, 뒷자리 0 제거)
                const formatted = ethAmount.toFixed(6).replace(/\.?0+$/, '');
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
        
        // 상품명 정보 추출 (서버 응답 우선, 그 다음 QR 데이터)
        const productName = result?.productName || 
                           result?.product ||
                           this.paymentData?.productName || 
                           this.paymentData?.product || 
                           this.paymentData?.item || 
                           this.paymentData?.name || 
                           '상품';
        
        this.addDebugLog(`상품명 추출 과정:`);
        this.addDebugLog(`- 서버 응답 productName: ${result?.productName}`);
        this.addDebugLog(`- 서버 응답 product: ${result?.product}`);
        this.addDebugLog(`- QR 데이터 productName: ${this.paymentData?.productName}`);
        this.addDebugLog(`- QR 데이터 product: ${this.paymentData?.product}`);
        this.addDebugLog(`- QR 데이터 item: ${this.paymentData?.item}`);
        this.addDebugLog(`- QR 데이터 name: ${this.paymentData?.name}`);
        this.addDebugLog(`- 최종 상품명: ${productName}`);
        
        this.addDebugLog(`최종 표시될 정보: ${amount} ${tokenSymbol}, 상품: ${productName}`);
        
        const resultInfo = document.getElementById('resultInfo');
        resultInfo.innerHTML = `
            <div class="payment-success-content">
                <div class="product-info">
                    <div class="product-name-large">${productName}</div>
                    <div class="amount-display">${amount} ${tokenSymbol}</div>
                </div>
                <div class="transaction-info">
                    <div class="tx-label">${this.getI18nText('transaction_hash')}</div>
                    <div class="tx-hash-full clickable-hash" onclick="window.open('https://bscscan.com/tx/${result.txHash}', '_blank')">${result.txHash}</div>
                </div>
                <div class="success-message-simple">
                    ${this.getI18nText('purchase_completed')}
                </div>
                <div id="remainingBalanceSection" class="remaining-balance-section">
                    <div class="remaining-balance-text">${this.getI18nText('remaining_balance_loading')}</div>
                </div>
            </div>
        `;
        
        // 결제 후 남은 잔고 조회 및 표시
        this.fetchAndDisplayRemainingBalance();
    }

    // 결제 완료 후 남은 잔고 조회 및 표시
    async fetchAndDisplayRemainingBalance() {
        if (!this.walletPrivateKey) {
            this.addDebugLog('개인키가 없어 남은 잔고를 조회할 수 없습니다.');
            return;
        }

        try {
            this.addDebugLog('결제 후 남은 잔고 조회 중...');

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
            this.addDebugLog('남은 잔고 조회 성공');
            this.addDebugLog(`ETH: ${result.balance.ethBalance.formatted}`);
            this.addDebugLog(`${result.balance.tokenBalance.symbol}: ${result.balance.tokenBalance.formatted}`);

            // 남은 잔고 표시
            this.displayRemainingBalance(result.balance);

        } catch (error) {
            this.addDebugLog(`남은 잔고 조회 실패: ${error.message}`);
            
            // 에러 시 남은 잔고 섹션에 에러 메시지 표시
            const remainingBalanceSection = document.getElementById('remainingBalanceSection');
            if (remainingBalanceSection) {
                remainingBalanceSection.innerHTML = `
                    <div class="remaining-balance-error">
                        남은 잔고를 조회할 수 없습니다.
                    </div>
                `;
            }
        }
    }

    // 결제 완료 후 남은 잔고 정보 UI에 표시
    displayRemainingBalance(balance) {
        const remainingBalanceSection = document.getElementById('remainingBalanceSection');
        if (!remainingBalanceSection) return;

        // 토큰 잔액을 TUSD 단위로 표시 (서버에서 받은 정확한 값 사용)
        const tokenBalance = balance.tokenBalance.formatted;

        remainingBalanceSection.innerHTML = `
            <div class="remaining-balance-content">
                <div class="remaining-balance-title">${this.getI18nText('remaining_balance_title')}</div>
                <div class="remaining-balance-amount">${tokenBalance} TUSD</div>
            </div>
        `;

        this.addDebugLog(`남은 잔고 표시 완료: ${tokenBalance} TUSD`);
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
        
        // 실패해도 트랜잭션 해시가 있을 수 있음 (리버트된 트랜잭션)
        const txHashSection = error.txHash ? `
            <div class="transaction-info">
                <div class="tx-label">실패한 거래 해시</div>
                <div class="tx-hash-full clickable-hash" onclick="window.open('https://bscscan.com/tx/${error.txHash}', '_blank')">${error.txHash}</div>
            </div>
        ` : '';
        
        const resultInfo = document.getElementById('resultInfo');
        resultInfo.innerHTML = `
            <div class="payment-error-content">
                <h2>결제 실패</h2>
                <div class="error-info">
                    <div class="error-message">${error.message}</div>
                    <div class="error-time">실패 시간: ${new Date().toLocaleString()}</div>
                </div>
                ${txHashSection}
                <div class="error-action">
                    다시 시도하거나 관리자에게 문의해주세요.
                </div>
            </div>
        `;
        
        const errorMessage = this.getI18nText('payment_failed') + ': ' + error.message;
        this.showStatus(errorMessage, 'error');
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
        
        // 데이터 초기화 (개인키는 보존)
        this.paymentData = null;
        this.wallet = null;
        this.provider = null;
        this.scanAttempts = 0;
        this.lastScanTime = null;
        this.pauseScanning = false;
        // this.walletPrivateKey = null; // 개인키는 유지 (새 스캔을 위해)
        this.lastScannedQR = null;
        this.lastScannedTime = 0;
        // this.firstQRScanned = false; // 개인키 스캔 상태도 유지
        

        
        // 비디오 컨테이너 스타일 초기화
        const videoContainer = document.querySelector('.video-container');
        if (videoContainer) {
            videoContainer.style.transform = 'scale(1)';
        }
        
        this.addDebugLog('상태 초기화 완료');
        this.showLocalizedStatus('scanner_reset', 'info');
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
        // 디버깅을 위해 임시 활성화
        console.log(`[PaymentScanner] ${message}`);
        
        // 화면에도 표시 (개발용)
        const timestamp = new Date().toLocaleTimeString();
        this.debugLogs.push(`[${timestamp}] ${message}`);
        
        // 최대 50개 로그만 유지
        if (this.debugLogs.length > 50) {
            this.debugLogs.shift();
        }
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
        statusEl.innerHTML = this.getI18nText('qr_detected');
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

    // 지갑 잔고 조회 (비활성화됨)
    async fetchAndDisplayBalance() {
        // 잔고 조회 비활성화
        return;
    }

    // 잔고 정보 UI에 표시 (비활성화됨)
    displayBalance(balance) {
        // 잔고 표시 비활성화
        return;
    }
}

// 페이지 로드 시 초기화
let paymentScannerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    paymentScannerInstance = new PaymentScanner();
    // 전역에서 접근 가능하도록 설정
    window.paymentScannerInstance = paymentScannerInstance;
});

// 페이지 떠나기 전 정리
window.addEventListener('beforeunload', async () => {
    if (paymentScannerInstance && paymentScannerInstance.isScanning) {
        await paymentScannerInstance.stopScanner();
    }
});

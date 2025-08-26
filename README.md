# 🪙 StableCoin Payment Server

MetaMask SDK와 EIP-7702 기반의 안전한 스테이블코인 결제 서버입니다.

## ✨ 주요 기능

- **EIP-7702 Authorization**: MetaMask Delegation Toolkit을 사용한 스마트 컨트랙트 위임
- **MetaMask SDK**: 안정적이고 최신의 MetaMask 연결 및 상호작용
- **Smart Account**: EIP-7702를 통한 EOA의 스마트 컨트랙트 업그레이드
- **Delegated Transfer**: 사용자 대신 서버가 트랜잭션을 실행하는 가스리스 결제
- **Web Interface**: 간편한 웹 기반 결제 인터페이스

## 🏗️ 기술 스택

- **Backend**: NestJS, TypeScript
- **Blockchain**: Viem, MetaMask SDK, MetaMask Delegation Toolkit
- **Frontend**: Vanilla JavaScript (ES Modules)
- **Standards**: EIP-7702, EIP-712, EIP-1193

## 📦 설치

```bash
# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env
```

## 🔧 환경 변수 설정

`.env` 파일에 다음 변수들을 설정하세요:

```bash
# 블록체인 설정
RPC_URL=https://sepolia.infura.io/v3/YOUR_PROJECT_ID
CHAIN_ID=11155111
DELEGATE_ADDRESS=0x...  # DeleGator 컨트랙트 주소

# 서버 설정  
SERVER_URL=http://localhost:4123
SPONSOR_PK=0x...        # 가스비 후원자 private key

# 결제 테스트 설정
PRIVATE_KEY=0x...       # 테스트용 사용자 private key
TOKEN=0x...             # 스테이블코인 토큰 주소
TO=0x...                # 받는 주소
AMOUNT_WEI=1000000      # 전송할 금액 (wei 단위)
```

## 🚀 실행

```bash
# 개발 모드
npm run start:dev

# 운영 모드
npm run start:prod

# 클라이언트 테스트 실행
node client.ts
```

## 🌐 사용법

### 1. 서버 시작
```bash
npm run start:dev
```

### 2. 웹 인터페이스 접속
브라우저에서 다음 URL로 접속:
```
http://localhost:4123/payment-page?token=0x...&to=0x...&amount=1000000
```

### 3. 결제 진행
1. **MetaMask 연결**: 'MetaMask 연결' 버튼 클릭
2. **EIP-7702 Authorization**: 자동으로 스마트 컨트랙트 위임 설정
3. **결제 승인**: '결제하기' 버튼 클릭하여 EIP-712 서명
4. **트랜잭션 실행**: 서버가 대신 가스비를 지불하여 실행

### 4. 명령줄 클라이언트 사용
```bash
# 환경 변수 설정 후
node client.ts
```

## 🔒 보안 기능

- **EIP-712 서명 검증**: 모든 결제 요청의 서명을 서버에서 검증
- **Nonce 관리**: 재생 공격 방지를 위한 nonce 시스템
- **잔고 확인**: 결제 전 사용자 토큰 잔고 검증
- **데드라인 설정**: 시간 제한이 있는 서명으로 타이밍 공격 방지

## 📋 API 엔드포인트

### GET `/payment-page`
결제 웹 인터페이스를 제공합니다.

**쿼리 파라미터:**
- `token`: 토큰 컨트랙트 주소
- `to`: 받는 주소  
- `amount`: 전송할 금액 (wei 단위)

### POST `/payment`
EIP-7702 및 EIP-712 기반 결제를 처리합니다.

**요청 본문:**
```typescript
{
  authority: string;           // 사용자 주소
  transfer: {
    from: string;
    token: string;
    to: string;
    amount: string;
    nonce: string;
    deadline: string;
  };
  domain: EIP712Domain;
  types: EIP712Types;
  signature712: string;        // EIP-712 서명
  authorization: {             // EIP-7702 Authorization
    chainId: number;
    address: string;
    nonce: number;
    signature: string;
  };
}
```

## 🔄 플로우 다이어그램

```
1. 사용자 → MetaMask SDK 연결
2. 사용자 → EIP-7702 Authorization 서명
3. 사용자 → Authorization을 블록체인에 제출
4. 사용자 → Smart Account 생성
5. 사용자 → EIP-712 Transfer 서명
6. 사용자 → 서버로 결제 요청 전송
7. 서버 → 서명 및 잔고 검증
8. 서버 → 대신 트랜잭션 실행 (가스비 지불)
9. 서버 → 사용자에게 결과 응답
```

## 🧪 테스트

```bash
# 단위 테스트
npm run test

# E2E 테스트  
npm run test:e2e

# 테스트 커버리지
npm run test:cov
```

## 📚 참고 자료

- [EIP-7702: Set EOA account code](https://eips.ethereum.org/EIPS/eip-7702)
- [MetaMask SDK 문서](https://docs.metamask.io/sdk/)
- [MetaMask Delegation Toolkit](https://github.com/metamask/delegation-toolkit)
- [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712)

## 🛠️ 개발

### 코드 포맷팅
```bash
npm run format
```

### 린트 검사
```bash
npm run lint
```

### 빌드
```bash
npm run build
```

## 📄 라이선스

이 프로젝트는 UNLICENSED 라이선스입니다.

## 🤝 기여

이슈나 풀 리퀘스트를 통해 기여해주세요.

## 📞 지원

문제가 있으시면 이슈를 생성해주세요.

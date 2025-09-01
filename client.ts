import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import { ethers, Signature } from 'ethers';

// QR 스캔으로 임시 설정된 환경변수 우선 사용, 없으면 .env 파일에서 기본값 로드
console.log('[CLIENT] 클라이언트 실행 시작');
console.log('[CLIENT] 환경변수 설정 상태 확인 시작...');

const envPath = path.resolve(process.cwd(), '.env');
const parsed = dotenv.parse(fs.readFileSync(envPath));

// QR 스캔 필수 필드들 (반드시 QR에서 와야 함)
const QR_REQUIRED_KEYS = ['PRIVATE_KEY', 'DELEGATE_ADDRESS', 'TOKEN', 'TO', 'AMOUNT_WEI'] as const;
// 기본값 사용 가능한 필드들
const FALLBACK_KEYS = ['RPC_URL', 'SERVER_URL', 'CHAIN_ID'] as const;

let qrDataUsed = false;
let missingQRFields: string[] = [];

// QR 필수 필드들 검증
for (const k of QR_REQUIRED_KEYS) {
  if (!process.env[k]) {
    missingQRFields.push(k);
    console.error(`[ERROR] QR 필수 필드 누락: ${k}`);
  } else {
    console.log(`[DEBUG] QR 스캔 데이터 사용: ${k} = ${k === 'PRIVATE_KEY' ? process.env[k]?.substring(0, 10) + '...' : process.env[k]}`);
    qrDataUsed = true;
  }
}

// QR 필수 필드가 없으면 에러
if (missingQRFields.length > 0) {
  console.error(`[CRITICAL ERROR] QR 코드에서 필수 데이터를 읽을 수 없습니다!`);
  console.error(`누락된 필드들: ${missingQRFields.join(', ')}`);
  console.error(`env 파일에서는 가져오지 않습니다. QR 코드를 다시 스캔해주세요.`);
  process.exit(1);
}

// 기본값 사용 가능한 필드들 처리
for (const k of FALLBACK_KEYS) {
  if (!process.env[k]) {
    const v = parsed[k as keyof typeof parsed];
    if (v != null) {
      process.env[k] = v.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '').trim();
      console.log(`[DEBUG] .env에서 기본값 로드: ${k} = ${process.env[k]}`);
    }
  } else {
    console.log(`[DEBUG] 환경변수 사용: ${k} = ${process.env[k]}`);
  }
}

console.log('[CLIENT] ✅ QR 스캔 데이터가 성공적으로 로드되었습니다.');

console.log('[CLIENT] 최종 환경변수 설정 시작');

const RPC_URL          = process.env.RPC_URL!;
const SERVER_URL       = process.env.SERVER_URL!;
const AUTHORITY_PK     = process.env.PRIVATE_KEY!;
const DELEGATE_ADDRESS = process.env.DELEGATE_ADDRESS!;
const TOKEN            = process.env.TOKEN!;
const TO               = process.env.TO!;
const AMOUNT_WEI       = process.env.AMOUNT_WEI!;
const CHAIN_ID         = Number(process.env.CHAIN_ID!);

console.log('[CLIENT] 최종 설정 값들:', {
  RPC_URL,
  SERVER_URL,
  DELEGATE_ADDRESS,
  TOKEN,
  TO,
  AMOUNT_WEI,
  CHAIN_ID,
  AUTHORITY_PK: AUTHORITY_PK.substring(0, 10) + '...'
});

type Transfer = {
  from: string;
  token: string;
  to: string;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

type AuthItem = {
  chainId: number;
  address: string;         // delegate(implementation) contract
  nonce: number;           // EOA tx nonce (not the contract nonce)
  signature: `0x${string}`; // 65B serialized sig
};

// slot0 읽기 (fallback)
async function readNextNonceViaStorage(provider: ethers.JsonRpcProvider, authority: string): Promise<bigint> {
  const raw = await provider.getStorage(authority, 0);
  console.log('raw', raw);
  return BigInt(raw || 0);
}

// authorizationList를 사용해 authority에서 nonce() view 호출
async function readNextNonceViaAuthorizedView(
  provider: ethers.JsonRpcProvider,
  authority: string,
  authItem: AuthItem
): Promise<bigint> {
  const iface = new ethers.Interface(['function nonce() view returns (uint256)']);
  const data  = iface.encodeFunctionData('nonce', []);

  // ✅ ethers v6: call은 인자 1개만. 'latest' 제거
  const ret = await provider.call({
    to: authority,
    data,
    // ★ EIP-7702 컨텍스트
    type: 4,
    authorizationList: [authItem] as any,
  } as any);

  // ✅ decode 결과는 ethers.Result. 안전하게 꺼내서 bigint로 캐스팅
  const decoded = iface.decodeFunctionResult('nonce', ret);
  const nextNonce = decoded[0] as bigint; // v6에선 uint256 -> bigint
  return nextNonce;
}

// 필요 시 fresh authorization 생성
async function ensureAuthorization(
  signer: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<AuthItem> {
  const authority     = signer.address;
  const eoaNonceLatest = await provider.getTransactionCount(authority, 'latest');

  const auth = await signer.authorize({
    address: DELEGATE_ADDRESS,
    nonce:   eoaNonceLatest,
    chainId: CHAIN_ID,
  });

  return {
    chainId: Number(auth.chainId),
    address: auth.address,
    nonce:   Number(auth.nonce),
    signature: (auth.signature as Signature).serialized as `0x${string}`,
  };
}

async function main() {
  const provider    = new ethers.JsonRpcProvider(RPC_URL);
  const firstSigner = new ethers.Wallet(AUTHORITY_PK, provider);
  const authority   = firstSigner.address;

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC chainId(${Number(net.chainId)}) != CHAIN_ID(${CHAIN_ID})`);
  }

  // 1) authorization 준비
  const authItem = await ensureAuthorization(firstSigner, provider);

  // 2) nextNonce 읽기: 우선 authorized view → 실패 시 slot0 폴백
  let nextNonce: bigint;
  try {
    nextNonce = await readNextNonceViaAuthorizedView(provider, authority, authItem);
  } catch (e: any) {
    console.warn('[warn] authorized nonce() view 실패, slot0 폴백 사용:', e?.shortMessage || e?.message || e);
    nextNonce = await readNextNonceViaStorage(provider, authority);
  }

  // 3) EIP-712 서명
  const domain = {
    name: 'DelegatedTransfer',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: authority, // EOA 자체
  } as const;

  const types = {
    Transfer: [
      { name: 'from',     type: 'address' },
      { name: 'token',    type: 'address' },
      { name: 'to',       type: 'address' },
      { name: 'amount',   type: 'uint256' },
      { name: 'nonce',    type: 'uint256' }, // == nextNonce
      { name: 'deadline', type: 'uint256' },
    ],
  } as const;

  const t: Transfer = {
    from:     authority,
    token:    TOKEN,
    to:       TO,
    amount:   BigInt(AMOUNT_WEI),
    nonce:    nextNonce,
    deadline: BigInt(Math.floor(Date.now()/1000) + 300), // 5분
  };

  const signature712 = await firstSigner.signTypedData(domain as any, types as any, t as any);

  // 4) 서버로 전송 (BigInt → 문자열)
  const body = {
    authority,
    transfer: {
      from: t.from,
      token: t.token,
      to:   t.to,
      amount:  t.amount.toString(),
      nonce:   t.nonce.toString(),
      deadline:t.deadline.toString(),
    },
    domain,
    types,
    signature712,
    authorization: authItem, // 재위임 재사용이면 생략 가능
  };

  const res = await axios.post(`${SERVER_URL}/payment`, body);
  console.log('server:', res.data);
}

main().catch((e) => { console.error(e); process.exit(1); });

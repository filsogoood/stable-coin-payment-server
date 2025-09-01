import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import { ethers, Signature } from 'ethers';

const envPath = path.resolve(process.cwd(), '.env');
const parsed = dotenv.parse(fs.readFileSync(envPath));

const KEYS = [
  'RPC_URL','SERVER_URL','PRIVATE_KEY','DELEGATE_ADDRESS',
  'TOKEN','TO','AMOUNT_WEI','CHAIN_ID'
] as const;
for (const k of KEYS) {
  const v = parsed[k as keyof typeof parsed];
  if (v != null) process.env[k] = v.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '').trim();
}

const RPC_URL          = process.env.RPC_URL!;
const SERVER_URL       = process.env.SERVER_URL!;
const AUTHORITY_PK     = process.env.PRIVATE_KEY!;
const DELEGATE_ADDRESS = process.env.DELEGATE_ADDRESS!;
const TOKEN            = process.env.TOKEN!;
const TO               = process.env.TO!;
const AMOUNT_WEI       = process.env.AMOUNT_WEI!;
const CHAIN_ID         = Number(process.env.CHAIN_ID!);

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

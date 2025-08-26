import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import { MetaMaskSDK } from '@metamask/sdk';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
async function readNextNonceViaStorage(publicClient: any, authority: Address): Promise<bigint> {
  const raw = await publicClient.getStorageAt({
    address: authority,
    slot: '0x0',
  });
  return BigInt(raw || 0);
}

// authorizationList를 사용해 authority에서 nonce() view 호출
async function readNextNonceViaAuthorizedView(
  publicClient: any,
  authority: Address,
  authItem: AuthItem
): Promise<bigint> {
  const abi = [
    {
      name: 'nonce',
      type: 'function',
      inputs: [],
      outputs: [{ type: 'uint256' }],
    }
  ] as const;

  const data = encodeFunctionData({
    abi,
    functionName: 'nonce',
    args: [],
  });

  const ret = await publicClient.call({
    to: authority,
    data,
    type: 'eip7702',
    authorizationList: [authItem],
  } as any);

  const decoded = decodeFunctionResult({
    abi,
    functionName: 'nonce',
    data: ret.data!,
  });

  return decoded as bigint;
}

// 필요 시 fresh authorization 생성
async function ensureAuthorization(
  account: any,
  walletClient: any,
  publicClient: any
): Promise<AuthItem> {
  const authority = account.address;
  const eoaNonceLatest = await publicClient.getTransactionCount({
    address: authority,
  });

  // viem의 signAuthorization 사용 (ethers의 authorize와 동일한 기능)
  const auth = await walletClient.signAuthorization({
    account,
    contractAddress: DELEGATE_ADDRESS as Address,
    nonce: eoaNonceLatest,
    executor: "self",
  });

  return {
    chainId: Number(auth.chainId),
    address: auth.address,
    nonce: Number(auth.nonce),
    signature: `0x${auth.r.slice(2)}${auth.s.slice(2)}${(auth.v || 0n).toString(16).padStart(2, '0')}` as `0x${string}`,
  };
}

async function main() {
  console.log('🚀 MetaMask SDK를 사용한 EIP-7702 결제 시작...');

  // MetaMask SDK 초기화 (Node.js 환경용)
  const MMSDK = new MetaMaskSDK({
    dappMetadata: {
      name: "StableCoin Payment Client",
      url: "http://localhost:3000", 
    },
    headless: true,
    extensionOnly: false,
  });

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  });

  const account = privateKeyToAccount(AUTHORITY_PK as Hex);
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  });

  const authority = account.address;

  const chainId = await publicClient.getChainId();
  if (Number(chainId) !== CHAIN_ID) {
    throw new Error(`RPC chainId(${Number(chainId)}) != CHAIN_ID(${CHAIN_ID})`);
  }

  console.log(`✅ 체인 연결 완료: ${CHAIN_ID}`);
  console.log(`🔑 Authority 주소: ${authority}`);

  try {
    // 1) authorization 준비
    console.log('📝 Authorization 생성 중...');
    const authItem = await ensureAuthorization(account, walletClient, publicClient);
    console.log('✅ Authorization 생성 완료');

    // 2) nextNonce 읽기: 우선 authorized view → 실패 시 slot0 폴백
    console.log('🔢 Nonce 읽기 중...');
    let nextNonce: bigint;
    try {
      nextNonce = await readNextNonceViaAuthorizedView(publicClient, authority, authItem);
      console.log(`✅ Authorized view nonce: ${nextNonce}`);
    } catch (e: any) {
      console.warn('[warn] authorized nonce() view 실패, slot0 폴백 사용:', e?.shortMessage || e?.message || e);
      nextNonce = await readNextNonceViaStorage(publicClient, authority);
      console.log(`✅ Storage slot nonce: ${nextNonce}`);
    }

    // 3) EIP-712 서명 (원본과 동일한 구조)
    console.log('✍️ EIP-712 서명 생성 중...');
    const domain = {
      name: 'DelegatedTransfer',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: DELEGATE_ADDRESS as Address, // 위임된 컨트랙트 주소 (EIP-7702 요구사항)
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

    // viem의 signTypedData 사용 (ethers의 signTypedData와 동일한 기능)
    const signature712 = await walletClient.signTypedData({
      account,
      domain: domain as any,
      types: types as any,
      primaryType: 'Transfer',
      message: t as any,
    });

    console.log('✅ EIP-712 서명 완료');

    // 4) 서버로 전송 (BigInt → 문자열, 원본과 동일한 구조)
    console.log('🌐 서버로 결제 요청 전송 중...');
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

    const res = await axios.post(`${SERVER_URL}/payment`, body, { timeout: 30_000 });
    console.log('✅ 서버 응답:', res.data);
    console.log('🎉 결제가 성공적으로 완료되었습니다!');

  } catch (error) {
    console.error('❌ 오류 발생:', error);
    throw error;
  } finally {
    // SDK 정리
    MMSDK.terminate();
  }
}

main().catch((e) => { 
  console.error('💥 치명적 오류:', e); 
  process.exit(1); 
});

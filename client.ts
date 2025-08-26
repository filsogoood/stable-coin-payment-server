// client.ts - 서버 기반 Authorization 처리로 변경
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

// slot0 읽기 (fallback)
async function readNextNonceViaStorage(publicClient: any, authority: string): Promise<bigint> {
  const raw = await publicClient.getStorageAt({
    address: authority as Address,
    slot: '0x0',
    blockTag: 'latest'
  });
  return BigInt(raw || 0);
}

async function main() {
  console.log('🚀 MetaMask SDK를 사용한 서버 기반 EIP-7702 가스리스 결제 시작...');

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
    // 1) nextNonce 읽기 (Authorization은 서버에서 처리하므로 간단하게 storage에서 읽기)
    console.log('🔢 Nonce 읽기 중...');
    
    let nextNonce: bigint;
    try {
      // storage slot에서 직접 읽기 (간단한 방법)
      nextNonce = await readNextNonceViaStorage(publicClient, authority);
      console.log('✅ Storage slot nonce:', nextNonce.toString());
    } catch (e) {
      console.warn('⚠️ Storage slot 읽기 실패, nonce 0 사용:', e?.message);
      nextNonce = BigInt(0);
    }

    // 2) EIP-712 서명 (private key로 직접 서명)
    console.log('✍️ EIP-712 서명 생성 중...');
    
    const domain = {
      name: 'DelegatedTransfer',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: DELEGATE_ADDRESS as Address, // 위임된 컨트랙트 주소 (EIP-7702 요구사항)
    };

    const types = {
      Transfer: [
        { name: 'from', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, // == nextNonce
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const transfer: Transfer = {
      from: authority,
      token: TOKEN,
      to: TO,
      amount: BigInt(AMOUNT_WEI),
      nonce: nextNonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300), // 5분
    };

    // private key로 직접 서명 (RPC가 signTypedData를 지원하지 않는 경우)
    const signature712 = await account.signTypedData({
      domain,
      types,
      primaryType: 'Transfer',
      message: transfer,
    });

    console.log('✅ EIP-712 서명 완료');

    // 3) 서버로 전송 (Authorization은 서버에서 생성됨)
    console.log('🌐 서버로 가스리스 결제 요청 전송 중...');
    
    const body = {
      authority,
      transfer: {
        from: transfer.from,
        token: transfer.token,
        to: transfer.to,
        amount: transfer.amount.toString(),
        nonce: transfer.nonce.toString(),
        deadline: transfer.deadline.toString(),
      },
      domain,
      types,
      signature712,
      // authorization은 서버에서 생성되므로 제거됨
    };

    // 서버의 새로운 엔드포인트 사용
    const response = await axios.post(`${SERVER_URL}/server-payment`, body, { 
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ 서버 응답:', response.data);
    
    if (response.data.status === 'ok') {
      console.log('🎉 가스리스 결제가 완료되었습니다!');
      console.log(`📋 트랜잭션 해시: ${response.data.txHash}`);
      console.log(`🔐 서버에서 생성된 Authorization: ${JSON.stringify(response.data.authorization, null, 2)}`);
    } else {
      throw new Error(response.data.message || '결제에 실패했습니다.');
    }

  } catch (error) {
    console.error('❌ 결제 중 오류 발생:', error);
    throw error;
  }
}

main().catch((e) => { 
  console.error('💥 전체 프로세스 실패:', e); 
  process.exit(1); 
});

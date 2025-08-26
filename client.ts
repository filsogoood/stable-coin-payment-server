import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import { 
  createWalletClient, 
  createPublicClient, 
  http, 
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Hex,
  type Address,
  type AuthorizationRequest,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

// 환경 변수 로드
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

// Helper functions
const formatAddr = (addr: string) => addr as Address;
const formatHex = (hex: string) => hex as Hex;

type Transfer = {
  from: Address;
  token: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

type AuthItem = {
  chainId: number;
  address: Address;
  nonce: number;
  signature: Hex;
};

const DELEGATE_ABI = parseAbi([
  'function executeSignedTransfer((address from,address token,address to,uint256 amount,uint256 nonce,uint256 deadline) t, bytes sig) external',
  'function nonce() view returns (uint256)',
]);

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
  const data = encodeFunctionData({
    abi: DELEGATE_ABI,
    functionName: 'nonce',
    args: [],
  });

  // Viem: authorized call
  const result = await publicClient.request({
    method: 'eth_call',
    params: [
      {
        to: authority,
        data,
        type: '0x4',
        authorizationList: [authItem],
      },
      'latest'
    ],
  });

  const decoded = decodeFunctionResult({
    abi: DELEGATE_ABI,
    functionName: 'nonce',
    data: result,
  });

  return decoded as bigint;
}

// EIP-7702 authorization 생성
async function ensureAuthorization(
  walletClient: any,
  publicClient: any,
  authority: Address
): Promise<AuthItem> {
  const eoaNonce = await publicClient.getTransactionCount({ 
    address: authority, 
    blockTag: 'latest' 
  });

  try {
    console.log('🔍 Creating EIP-7702 authorization with Viem...');
    console.log('  - Delegate Address:', DELEGATE_ADDRESS);
    console.log('  - Chain ID:', CHAIN_ID);
    console.log('  - EOA Nonce:', eoaNonce);

    // Viem의 signAuthorization 사용
    const authorization = await walletClient.signAuthorization({
      contractAddress: formatAddr(DELEGATE_ADDRESS),
      chainId: CHAIN_ID,
      nonce: eoaNonce,
    });

    console.log('✅ Authorization created:', {
      chainId: authorization.chainId,
      address: authorization.contractAddress,
      nonce: authorization.nonce,
      signature: authorization.signature,
    });

    return {
      chainId: authorization.chainId,
      address: authorization.contractAddress,
      nonce: authorization.nonce,
      signature: authorization.signature,
    };

  } catch (error: any) {
    console.error('❌ EIP-7702 authorization 실패:', error);
    
    // 구체적인 에러 메시지
    let errorMsg = 'EIP-7702 authorization 실패: ';
    if (error?.message?.includes('not supported')) {
      errorMsg += 'Viem에서 EIP-7702가 지원되지 않습니다. 최신 버전을 사용하세요.';
    } else {
      errorMsg += error?.message || '알 수 없는 오류';
    }
    
    throw new Error(errorMsg);
  }
}

async function main() {
  // Sepolia 체인 설정
  const chain = sepolia;
  
  // Public Client 생성 (읽기 전용)
  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  });

  // Account 생성
  const account = privateKeyToAccount(formatHex(AUTHORITY_PK));
  const authority = account.address;

  // Wallet Client 생성 (트랜잭션 전송용)
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(RPC_URL),
  });

  // 체인 ID 확인
  const chainId = await publicClient.getChainId();
  if (Number(chainId) !== CHAIN_ID) {
    throw new Error(`RPC chainId(${Number(chainId)}) != CHAIN_ID(${CHAIN_ID})`);
  }

  console.log('🚀 Starting EIP-7702 payment with Viem');
  console.log('  - Authority:', authority);
  console.log('  - Chain:', chain.name);

  // 1) authorization 준비
  const authItem = await ensureAuthorization(walletClient, publicClient, authority);

  // 2) nextNonce 읽기: 우선 authorized view → 실패 시 slot0 폴백
  let nextNonce: bigint;
  try {
    nextNonce = await readNextNonceViaAuthorizedView(publicClient, authority, authItem);
    console.log('✅ Got nonce via authorized view:', nextNonce.toString());
  } catch (e: any) {
    console.warn('[warn] authorized nonce() view 실패, slot0 폴백 사용:', e?.message);
    nextNonce = await readNextNonceViaStorage(publicClient, authority);
    console.log('✅ Got nonce via slot0:', nextNonce.toString());
  }

  // 3) EIP-712 서명
  const domain = {
    name: 'DelegatedTransfer',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: formatAddr(DELEGATE_ADDRESS),
  } as const;

  const types = {
    Transfer: [
      { name: 'from',     type: 'address' },
      { name: 'token',    type: 'address' },
      { name: 'to',       type: 'address' },
      { name: 'amount',   type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  } as const;

  const transfer: Transfer = {
    from:     authority,
    token:    formatAddr(TOKEN),
    to:       formatAddr(TO),
    amount:   BigInt(AMOUNT_WEI),
    nonce:    nextNonce,
    deadline: BigInt(Math.floor(Date.now()/1000) + 300), // 5분
  };

  console.log('🖊️  Signing EIP-712 message...');
  const signature712 = await walletClient.signTypedData({
    domain,
    types,
    primaryType: 'Transfer',
    message: transfer,
  });

  console.log('✅ EIP-712 signature:', signature712);

  // 4) 서버로 전송
  const body = {
    authority: authority,
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
    authorization: authItem,
  };

  console.log('📤 Sending to server...');
  const res = await axios.post(`${SERVER_URL}/payment`, body);
  console.log('✅ Server response:', res.data);
}

main().catch((e) => { 
  console.error('❌ Error:', e); 
  process.exit(1); 
});

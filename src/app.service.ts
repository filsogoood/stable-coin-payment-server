// app.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ethers, Interface } from 'ethers';

type Hex = `0x${string}`;

@Injectable()
export class AppService {
  private readonly logger = new Logger('AppService');

  private provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  // ⭐ 가스비 대납자(Sponsor/Relayer): 받는 쪽에서 트랜잭션 가스비를 대신 지불
  private relayer  = new ethers.Wallet(process.env.SPONSOR_PK!, this.provider);

  private readonly DELEGATE_ABI = [
    'function executeSignedTransfer((address from,address token,address to,uint256 amount,uint256 nonce,uint256 deadline) t, bytes sig) external',
    'function nonce() view returns (uint256)',  // 뷰 호출용
  ];
  private readonly delegateIface = new Interface(this.DELEGATE_ABI);

  private readonly ERR_ABI = [
    'error BadContext(address actual,address expected)',
    'error Expired(uint256 nowTs,uint256 deadline)',
    'error BadSignature(address expected,address recovered)',
    'error BadNonce(uint256 got,uint256 expected)',
    'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
    'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
    'error SafeERC20FailedOperation(address token)',
  ];
  private readonly errIface = new Interface(this.ERR_ABI);

  private isAddr(a?: string) { return !!a && /^0x[0-9a-fA-F]{40}$/.test(a); }
  private eqAddr(a?: string, b?: string) { return !!a && !!b && a.toLowerCase() === b.toLowerCase(); }
  private short(h?: string, n=6) { return (!h||!h.startsWith('0x'))?String(h):(`${h.slice(0,2+n)}…${h.slice(-n)}`); }
  private j(obj: any) { return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2); }

  private decodeAndLogRevert(e: any, tag: string) {
    const data = e?.info?.error?.data || e?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        const parsed = this.errIface.parseError(data);
        this.logger.error(`[${tag}] ${parsed?.name} args=${this.j(parsed?.args)}`);
        return parsed;
      } catch {/* ignore */}
    }
    this.logger.error(`[${tag}] ${e?.shortMessage || e?.message || e}`);
    return null;
  }

  // ─────────────────────────────────────────
  // nextNonce 읽기: ① authorization 있으면 nonce() 뷰 호출 시도 → 실패 시 ② slot0
  // ─────────────────────────────────────────
  private async readNextNonce(authority: string, authorization?: {
    chainId: number; address: string; nonce: number; signature: Hex;
  }): Promise<bigint> {
    // ① nonce() 뷰 시도 (type:4 + authorizationList 필요)
    if (authorization?.signature) {
      try {
        const data = this.delegateIface.encodeFunctionData('nonce', []);
        const ret = await this.provider.call({
          to: authority,
          data,
          type: 4,
          authorizationList: [authorization],
        } as any);
        const [val] = this.delegateIface.decodeFunctionResult('nonce', ret);
        const out = BigInt(val.toString());
        this.logger.debug(`[nextNonce:view] ${out.toString()}`);
        return out;
      } catch (e:any) {
        this.decodeAndLogRevert(e, 'nextNonce:view');
        // 폴백으로 진행
      }
    }

    // ② slot0 직접 조회 (EIP-7702 컨텍스트 없어도 항상 동작)
    const raw = await this.provider.getStorage(authority, 0);
    const out = BigInt(raw || 0);
    this.logger.debug(`[nextNonce:slot0] ${out.toString()}`);
    return out;
  }

  // (옵션) 클라이언트가 미리 nextNonce만 요청할 수 있게 제공
  async getNextNonce(authority: string, authorization?: { chainId:number; address:string; nonce:number; signature:Hex }) {
    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    const next = await this.readNextNonce(authority, authorization);
    return { authority, nextNonce: next.toString(), via: authorization?.signature ? 'view-or-slot' : 'slot' };
  }

  // 메인 실행
  async payment(body: any) {
    const { authority, transfer, domain, types, signature712, authorization } = body ?? {};
    this.logger.debug(`[ADDRESS_DEBUG] authority=${authority}`);
    
    // ⭐ 가스비 대납 정보 로깅
    this.logger.log(`[GAS_SPONSOR] 가스비 대납자: ${this.relayer.address}`);
    this.logger.log(`[GAS_SPONSOR] 보내는 사람(${authority})은 가스비를 지불하지 않습니다.`);

    if (!this.isAddr(authority)) throw new BadRequestException('authority invalid');
    if (!transfer) throw new BadRequestException('transfer missing');
    if (!this.isAddr(transfer.from) || !this.isAddr(transfer.token) || !this.isAddr(transfer.to)) {
      throw new BadRequestException('transfer address invalid');
    }

    const net = await this.provider.getNetwork();
    if (Number(net.chainId) !== Number(domain?.chainId)) throw new BadRequestException('chainId mismatch');
    // verifyingContract는 delegate 주소를 사용 (MetaMask 보안 정책)
    const delegateAddress = process.env.DELEGATE_ADDRESS || '0x8ea3B7F221e883EF51175c24Fff469FE90D59669';
    this.logger.debug(`[VERIFY] Expected delegate: ${delegateAddress}, Got verifyingContract: ${domain?.verifyingContract}`);
    if (!this.eqAddr(domain?.verifyingContract, delegateAddress)) throw new BadRequestException('verifyingContract must equal delegate address');
    if (!this.eqAddr(transfer.from, authority)) throw new BadRequestException('transfer.from must equal authority');

    const recovered = ethers.verifyTypedData(
      domain, types,
      {
        from: transfer.from,
        token: transfer.token,
        to:   transfer.to,
        amount: BigInt(String(transfer.amount)),
        nonce:  BigInt(String(transfer.nonce)),
        deadline: BigInt(String(transfer.deadline ?? 0)),
      },
      signature712
    );
    if (!this.eqAddr(recovered, authority)) {
      throw new BadRequestException({ code: 'BAD_712_SIGNER', recovered, authority });
    }

    // ★ 여기서 nextNonce를 읽는다: authorization 있으면 nonce() 우선, 없으면 slot0
    const onchainNext = await this.readNextNonce(authority, authorization?.signature ? {
      chainId: Number(authorization.chainId),
      address: authorization.address,
      nonce:   Number(authorization.nonce),
      signature: authorization.signature as Hex,
    } : undefined);

    const tNonce = BigInt(String(transfer.nonce));
    if (onchainNext !== tNonce) {
      throw new BadRequestException({
        code: 'BAD_NONCE',
        message: 'transfer.nonce does not match onchain nextNonce',
        got: tNonce.toString(),
        expected: onchainNext.toString(),
      });
    }

    // 잔고 체크
    const erc20 = new ethers.Contract(
      transfer.token,
      [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ],
      this.provider
    );
    let bal: bigint;
    try {
      const b = await erc20.balanceOf(authority);
      bal = BigInt(b.toString());
    } catch {
      bal = 0n;
    }
    const needed = BigInt(String(transfer.amount));
    if (bal < needed) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        balance: bal.toString(),
        needed: needed.toString(),
      });
    }

    // calldata
    const calldata = this.delegateIface.encodeFunctionData('executeSignedTransfer', [
      {
        from: transfer.from,
        token: transfer.token,
        to:   transfer.to,
        amount: needed,
        nonce:  tNonce,
        deadline: BigInt(String(transfer.deadline ?? 0)),
      },
      signature712,
    ]);
    this.logger.debug(`[calldata] len=${(calldata.length-2)/2}B hash=${this.short(ethers.keccak256(calldata))}`);

    // authorizationList
    const authList: Array<{ chainId:number; address:string; nonce:number; signature:Hex; }> = [];
    if (authorization?.signature) {
      if (!this.isAddr(authorization.address)) throw new BadRequestException('authorization.address invalid');
      authList.push({
        chainId: Number(authorization.chainId),
        address: authorization.address,
        nonce:   Number(authorization.nonce),
        signature: authorization.signature as Hex,
      });
    }

    // simulate
    try {
      await this.provider.call({
        to: authority,
        data: calldata,
        type: 4,
        authorizationList: authList,
      } as any);
      this.logger.log('[simulate] OK');
    } catch (e:any) {
      const parsed = this.decodeAndLogRevert(e, 'simulate');
      if (parsed?.name === 'BadNonce' && parsed?.args?.length >= 2) {
        const got = BigInt(String(parsed.args[0]));
        const expected = BigInt(String(parsed.args[1]));
        throw new BadRequestException({
          code: 'BAD_NONCE',
          got: got.toString(),
          expected: expected.toString(),
        });
      }
      throw e;
    }

    // send
    this.logger.log(`[GAS_SPONSOR] 가스비 대납 트랜잭션 전송 중...`);
    const tx = await this.relayer.sendTransaction({
      to: authority,
      data: calldata,
      type: 4,
      authorizationList: authList as any,
    });

    // 가스비 대납 결과 로깅
    let gasUsed: bigint | undefined;
    let gasPrice: bigint | undefined;
    
    try {
      const rc = await tx.wait();
      gasUsed = rc?.gasUsed;
      gasPrice = rc?.gasPrice;
      
      const gasCost = gasUsed && gasPrice ? gasUsed * gasPrice : undefined;
      
      this.logger.log(`[mined] status=${rc?.status} gasUsed=${rc?.gasUsed?.toString()}`);
      
      // ⭐ 가스비 대납 상세 정보
      if (gasCost) {
        const gasCostEth = ethers.formatEther(gasCost);
        this.logger.log(`[GAS_SPONSOR] 대납된 가스비: ${gasCostEth} ETH`);
        this.logger.log(`[GAS_SPONSOR] 대납자 주소: ${this.relayer.address}`);
      }
    } catch (e:any) {
      this.logger.warn(`[wait] ${e?.message || e}`);
    }

    return { 
      status: 'ok', 
      txHash: tx.hash,
      gasSponsor: this.relayer.address,
      gasSponsorshipEnabled: true,
      message: '가스비가 받는 쪽에서 대납되었습니다.'
    };
  }
}

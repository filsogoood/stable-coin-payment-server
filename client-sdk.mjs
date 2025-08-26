// client-sdk.mjs
// MetaMask SDK를 사용하는 클라이언트 (브라우저/모바일 연결용)
// 실행: node client-sdk.mjs

import { MetaMaskSDK } from '@metamask/sdk';
import { 
  createWalletClient, 
  createPublicClient,
  custom,
  http,
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult
} from 'viem';
import { sepolia } from 'viem/chains';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import express from 'express';

// __dirname 대체
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 환경 변수 로드
const envPath = path.resolve(__dirname, '.env');
const parsed = dotenv.parse(fs.readFileSync(envPath));

Object.keys(parsed).forEach(key => {
  process.env[key] = parsed[key];
});

const SERVER_URL = process.env.SERVER_URL;
const DELEGATE_ADDRESS = process.env.DELEGATE_ADDRESS;
const TOKEN = process.env.TOKEN;
const TO = process.env.TO;
const AMOUNT_WEI = process.env.AMOUNT_WEI;
const CHAIN_ID = Number(process.env.CHAIN_ID);

// Express 서버 생성 (MetaMask SDK 연결용)
const app = express();
const PORT = 3456;

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>MetaMask SDK Payment Client</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        h1 {
            color: #333;
            text-align: center;
        }
        .status {
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            text-align: center;
        }
        .info { background: #d1ecf1; color: #0c5460; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        button {
            background: linear-gradient(45deg, #f6851b, #e2761b);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 5px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            margin: 10px 0;
        }
        button:hover {
            opacity: 0.9;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .details {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            font-family: monospace;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🦊 MetaMask SDK Payment Client</h1>
        
        <div class="details">
            <strong>Payment Details:</strong><br>
            Token: ${TOKEN}<br>
            To: ${TO}<br>
            Amount: ${AMOUNT_WEI} wei<br>
            Network: Sepolia
        </div>
        
        <button id="connectBtn" onclick="connect()">Connect MetaMask</button>
        <button id="payBtn" onclick="pay()" disabled>Sign & Pay</button>
        
        <div id="status"></div>
    </div>

    <script type="module">
        import { MetaMaskSDK } from 'https://esm.sh/@metamask/sdk@0.31.2';
        import { 
            createWalletClient, 
            createPublicClient,
            custom,
            http
        } from 'https://esm.sh/viem@2.21.0';
        import { sepolia } from 'https://esm.sh/viem@2.21.0/chains';

        const MMSDK = new MetaMaskSDK({
            dappMetadata: {
                name: "Payment Client",
                url: window.location.origin,
            },
            logging: { developerMode: true },
            checkInstallationImmediately: false,
        });

        const ethereum = MMSDK.getProvider();
        let account = null;
        let walletClient = null;

        window.connect = async function() {
            const statusDiv = document.getElementById('status');
            const connectBtn = document.getElementById('connectBtn');
            const payBtn = document.getElementById('payBtn');
            
            try {
                statusDiv.innerHTML = '<div class="status info">Connecting to MetaMask...</div>';
                connectBtn.disabled = true;

                const accounts = await ethereum.request({ 
                    method: 'eth_requestAccounts' 
                });
                
                account = accounts[0];
                walletClient = createWalletClient({
                    chain: sepolia,
                    transport: custom(ethereum)
                });

                statusDiv.innerHTML = '<div class="status success">Connected: ' + account + '</div>';
                connectBtn.textContent = 'Connected ✓';
                payBtn.disabled = false;
                
            } catch (error) {
                statusDiv.innerHTML = '<div class="status error">Connection failed: ' + error.message + '</div>';
                connectBtn.disabled = false;
            }
        }

        window.pay = async function() {
            const statusDiv = document.getElementById('status');
            const payBtn = document.getElementById('payBtn');
            
            try {
                statusDiv.innerHTML = '<div class="status info">Processing payment...</div>';
                payBtn.disabled = true;

                // 여기에 실제 결제 로직 구현
                // EIP-7702 authorization, EIP-712 서명 등
                
                // 서버에 결제 데이터 전송
                const response = await fetch('/process-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account })
                });

                const result = await response.json();
                
                if (result.success) {
                    statusDiv.innerHTML = '<div class="status success">Payment successful! TX: ' + result.txHash + '</div>';
                } else {
                    throw new Error(result.error);
                }
                
            } catch (error) {
                statusDiv.innerHTML = '<div class="status error">Payment failed: ' + error.message + '</div>';
                payBtn.disabled = false;
            }
        }

        // Auto-connect if already connected
        window.addEventListener('load', async () => {
            try {
                const accounts = await ethereum.request({ method: 'eth_accounts' });
                if (accounts.length > 0) {
                    await window.connect();
                }
            } catch (error) {
                console.log('Auto-connect failed:', error);
            }
        });
    </script>
</body>
</html>
  `);
});

// 결제 처리 엔드포인트
app.post('/process-payment', express.json(), async (req, res) => {
  try {
    const { account } = req.body;
    
    // 실제 결제 처리 로직
    // ...
    
    res.json({ 
      success: true, 
      txHash: '0x' + '0'.repeat(64),
      message: 'Payment processed successfully'
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 MetaMask SDK Client running at http://localhost:${PORT}`);
  console.log('📱 Open this URL in your browser or scan with MetaMask Mobile');
  
  // 브라우저 자동 열기
  open(`http://localhost:${PORT}`);
});

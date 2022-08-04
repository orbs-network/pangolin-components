/* eslint-disable max-lines */
import { Token } from '@pangolindex/sdk';
import BN from 'bn.js';
import { baseDecode } from 'borsh';
import { Contract, providers, transactions, utils } from 'near-api-js';
import { NEAR_EXCHANGE_CONTRACT_ADDRESS, near } from 'src/connectors';
import {
  NEAR_ACCOUNT_MIN_STORAGE_AMOUNT,
  NEAR_MIN_DEPOSIT_PER_TOKEN,
  NEAR_STORAGE_PER_TOKEN,
  ONE_YOCTO_NEAR,
} from 'src/constants';
import { PoolType } from 'src/data/Reserves';

export interface ViewFunctionOptions {
  methodName: string;
  args?: object;
}

export interface FunctionCallOptions extends ViewFunctionOptions {
  gas?: string;
  amount?: string | null;
}

export interface Transaction {
  receiverId: string;
  functionCalls: FunctionCallOptions[];
}

export interface PoolRPCView {
  id: number;
  token_account_ids: string[];
  token_symbols: string[];
  amounts: string[];
  total_fee: number;
  shares_total_supply: string;
  tvl: number;
  token0_ref_price: string;
  share: string;
  decimalsHandled?: boolean;
}

class Near {
  public async viewFunction(
    tokenId: string,
    {
      methodName,
      args,
    }: {
      methodName: string;
      args?: object;
    },
  ) {
    return near.wallet.account().viewFunction(tokenId, methodName, args);
  }

  getAccountId = () => {
    return near?.wallet?.account?.()?.accountId;
  };

  getTransaction = async (hash: string): Promise<providers.FinalExecutionOutcome | undefined> => {
    try {
      const accountId = near?.wallet?.account?.()?.accountId;
      const provider = await near.getProvider();
      return provider?.txStatus(hash, accountId);
    } catch (error) {
      console.log(error);
      return undefined;
    }
  };

  getTranctionSummary = (tx: providers.FinalExecutionOutcome) => {
    let summary = '';

    const methodName = tx.transaction?.actions?.[0]?.FunctionCall?.method_name;
    if (methodName === 'ft_transfer_call') {
      summary = 'Swap successful';
    } else if (methodName === 'add_liquidity') {
      summary = 'Add Liquidity successful';
    }

    return summary;
  };

  public async getMetadata(tokenAddress: string) {
    try {
      const metadata = await this.viewFunction(tokenAddress, {
        methodName: 'ft_metadata',
      });

      return {
        tokenAddress,
        ...metadata,
      };
    } catch (err) {
      return {
        tokenAddress,
        name: tokenAddress,
        symbol: tokenAddress?.split('.')[0].slice(0, 8),
        decimals: 6,
        icon: '',
      };
    }
  }

  public async getTokenBalance(tokenAddress: string, account?: string) {
    return this.viewFunction(tokenAddress, {
      methodName: 'ft_balance_of',
      args: {
        account_id: account,
      },
    });
  }

  public async getTotalSupply(tokenAddress: string) {
    return this.viewFunction(tokenAddress, {
      methodName: 'ft_total_supply',
      args: {},
    });
  }

  public async getExchangeContract(deployer, exchange) {
    const contract = new Contract(deployer, exchange, {
      viewMethods: ['get_pools', 'get_number_of_pools'],
      changeMethods: [],
    });
    return contract as any;
  }

  public async getAllPools(chainId: number) {
    const deployer = await near.wallet.account();
    const contract = await this.getExchangeContract(deployer, NEAR_EXCHANGE_CONTRACT_ADDRESS[chainId]);
    const numberOfPools = await contract.get_number_of_pools();
    return contract.get_pools({
      from_index: 0,
      limit: numberOfPools,
    });
  }

  public async getPoolId(chainId: number, tokenA?: Token, tokenB?: Token) {
    const results = await this.getAllPools(chainId);

    return results.findIndex((element) => {
      if (element?.pool_kind !== PoolType.SIMPLE_POOL) return false;

      const tokenIds = element?.token_account_ids || [];

      if (tokenIds.includes(tokenA?.address) && tokenIds.includes(tokenB?.address)) {
        return true;
      }

      return false;
    });
  }

  public async getPool(chainId: number, tokenA?: Token, tokenB?: Token): Promise<PoolRPCView> {
    const poolId = await this.getPoolId(chainId, tokenA, tokenB);

    return this.viewFunction(NEAR_EXCHANGE_CONTRACT_ADDRESS[chainId], {
      methodName: 'get_pool',
      args: { pool_id: poolId },
    });
  }

  public getStorageBalance(
    contractId: string,
    account = near?.wallet?.account?.()?.accountId,
  ): Promise<{
    total: string;
    available: string;
  } | null> {
    return this.viewFunction(contractId, {
      methodName: 'storage_balance_of',
      args: { account_id: account },
    });
  }

  public async needDepositStorage(
    contractId: string,
    account = near?.wallet?.account?.()?.accountId,
  ): Promise<boolean> {
    const storage = await this.viewFunction(contractId, {
      methodName: 'get_user_storage_state',
      args: { account_id: account },
    });

    return new BN(storage?.deposit).lte(new BN(storage?.usage));
  }

  public async checkUserNeedsStorageDeposit(chainId: number) {
    let storageNeeded = 0;

    const needDeposit = await nearFn.needDepositStorage(NEAR_EXCHANGE_CONTRACT_ADDRESS[chainId]);
    if (needDeposit) {
      storageNeeded = Number('0.01');
    } else {
      const balance = await this.getStorageBalance(NEAR_EXCHANGE_CONTRACT_ADDRESS[chainId]);

      if (!balance) {
        storageNeeded = Number(storageNeeded) + Number(NEAR_ACCOUNT_MIN_STORAGE_AMOUNT);
      }

      if (new BN(balance?.available || '0').lt(NEAR_MIN_DEPOSIT_PER_TOKEN)) {
        storageNeeded = Number(storageNeeded) + Number(NEAR_STORAGE_PER_TOKEN);
      }
    }

    return storageNeeded ? storageNeeded.toString() : '';
  }

  public async getWhitelistedTokens(chainId: number): Promise<string[]> {
    let userWhitelist = [];
    const contractId = NEAR_EXCHANGE_CONTRACT_ADDRESS[chainId];
    const accountId = near?.wallet?.account?.()?.accountId;

    const globalWhitelist = await this.viewFunction(contractId, {
      methodName: 'get_whitelisted_tokens',
      args: {},
    });

    userWhitelist = await this.viewFunction(contractId, {
      methodName: 'get_user_whitelisted_tokens',
      args: { account_id: accountId },
    });

    return [...new Set<string>([...globalWhitelist, ...userWhitelist])];
  }

  public async createNearTransaction({
    receiverId,
    actions,
    nonceOffset = 1,
  }: {
    receiverId: string;
    actions: transactions.Action[];
    nonceOffset?: number;
  }) {
    const accountId = await near.wallet.getAccountId();
    const walletAccount = await near.wallet.account();

    const localKey = await walletAccount.connection.signer.getPublicKey(accountId, near.wallet._networkId);
    const accessKey = await walletAccount.accessKeyForTransaction(receiverId, actions, localKey);
    if (!accessKey) {
      throw new Error(`Cannot find matching key for transaction sent to ${receiverId}`);
    }

    const block = await walletAccount.connection.provider.block({ finality: 'final' });
    const blockHash = baseDecode(block.header.hash);

    const publicKey = utils.PublicKey.from(accessKey.public_key);
    const nonce = accessKey.access_key.nonce + nonceOffset;

    return transactions.createTransaction(accountId, publicKey, receiverId, nonce, actions, blockHash);
  }

  public getGas = (gas?: string) => (gas ? new BN(gas) : new BN('100000000000000'));
  public getAmount = (amount?: string | null) => {
    if (amount) {
      const parseAmount = utils.format.parseNearAmount(amount);
      return parseAmount ? new BN(parseAmount) : new BN('0');
    } else {
      return new BN('0');
    }
  };

  public async executeMultipleTransactions(allTransactions: Transaction[]) {
    const currentTransactions = await Promise.all(
      allTransactions.map((t, i) => {
        return this.createNearTransaction({
          receiverId: t.receiverId,
          nonceOffset: i + 1,
          actions: t.functionCalls.map((fc) =>
            transactions.functionCall(
              fc.methodName,
              fc?.args ? fc?.args : {},
              this.getGas(fc.gas),
              this.getAmount(fc?.amount),
            ),
          ),
        });
      }),
    );

    return near.wallet.requestSignTransactions(currentTransactions);
  }
}

export const nearFn = new Near();

interface StorageDepositActionOptions {
  accountId?: string;
  registrationOnly?: boolean;
  amount: string;
}

export const storageDepositAction = ({
  accountId = nearFn.getAccountId(),
  registrationOnly = false,
  amount,
}: StorageDepositActionOptions): FunctionCallOptions => ({
  methodName: 'storage_deposit',
  args: {
    account_id: accountId,
    registration_only: registrationOnly,
  },
  amount,
});

export const registerTokenAction = (tokenId: string) => ({
  methodName: 'register_tokens',
  args: { token_ids: [tokenId] },
  amount: ONE_YOCTO_NEAR,
  gas: '30000000000000',
});
/* eslint-enable max-lines */

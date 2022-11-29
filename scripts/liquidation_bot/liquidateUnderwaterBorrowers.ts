import hre from 'hardhat';
import axios from 'axios';
import {
  CometInterface,
  Liquidator,
  LiquidatorV2,
} from '../../build/types';
import { exp } from '../../test/helpers';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { Signer } from 'ethers';
import googleCloudLog, { LogSeverity } from './googleCloudLog';
import {sendTxn} from './sendTransaction';

export interface SignerWithFlashbots {
  signer: Signer;
  flashbotsProvider?: FlashbotsBundleProvider;
}

export interface Asset {
  address: string;
  priceFeed: string;
  scale: bigint;
}

// XXX pull from network param
const chainId = 1;
// XXX delete
const walletAddress = '0x5a13D329A193ca3B1fE2d7B459097EdDba14C28F';

const apiBaseUrl = 'https://api.1inch.io/v5.0/' + chainId;

function apiRequestUrl(methodName, queryParams) {
  return apiBaseUrl + methodName + '?' + (new URLSearchParams(queryParams)).toString();
}

export async function attemptLiquidation(
  comet: CometInterface,
  liquidator: LiquidatorV2,
  targetAddresses: string[],
  signerWithFlashbots: SignerWithFlashbots,
  network: string
) {
  // get the amount of collateral available for sale (using static call)
  const [
    addresses,
    collateralReserves,
    collateralReservesInBase
  ] = await liquidator.callStatic.availableCollateral(targetAddresses);

  const baseToken = await comet.baseToken();

  let assets = [];
  let assetBaseAmounts = [];
  let swapTargets = [];
  let swapCallDatas = [];

  // for each amount, if it is high enough, get a quote
  for (const i in addresses) {
    const address = addresses[i];
    const collateralReserveAmount = collateralReserves[i];
    const collateralReserveAmountInBase = collateralReservesInBase[i];

    // check if collateralReserveAmountInBase is greater than threshold
    const liquidationThreshold = 0; // XXX increase

    if (collateralReserveAmountInBase > liquidationThreshold) {
      const swapParams = {
        fromTokenAddress: address,
        toTokenAddress: baseToken,
        amount: collateralReserveAmount, // amount in terms of fromToken
        fromAddress: walletAddress,
        slippage: 1,
        disableEstimate: true,
        allowPartialFill: false,
      };
      const url = apiRequestUrl('/swap', swapParams);
      const { data } = await axios.get(url);

      console.log(`data:`);
      console.log(data);

      assets.push(address);
      assetBaseAmounts.push(collateralReserveAmountInBase);
      swapTargets.push(data.tx.to);
      swapCallDatas.push(data.tx.data);
    }
  }

  console.log(`swapTargets:`);
  console.log(swapTargets);

  console.log(`swapCallDatas:`);
  console.log(swapCallDatas);

  console.log("absorbAndArbitrage()");

  await liquidator.absorbAndArbitrage(
    targetAddresses,
    assets,
    assetBaseAmounts,
    swapTargets,
    swapCallDatas
  );

  console.log("absorbAndArbitrage() done");

  // try {
  //   googleCloudLog(LogSeverity.INFO, `Attempting to liquidate ${targetAddresses} via ${liquidator.address}`);
  //   const flashLoanPool = flashLoanPools[network];
  //   const calldata = {
  //     accounts: targetAddresses,
  //     pairToken: flashLoanPool.tokenAddress,
  //     poolFee: flashLoanPool.poolFee
  //   };
  //   // XXX set appropriate gas price...currently we are overestimating slightly to be safe
  //   // XXX also factor in gas price to profitability
  //   const txn = await liquidator.connect(signerWithFlashbots.signer).populateTransaction.initFlash(calldata, {
  //     gasLimit: Math.ceil(1.1 * (await liquidator.estimateGas.initFlash(calldata)).toNumber()),
  //     gasPrice: Math.ceil(1.1 * (await hre.ethers.provider.getGasPrice()).toNumber()),
  //   });
  //   const success = await sendTxn(txn, signerWithFlashbots);
  //   if (success) {
  //     googleCloudLog(LogSeverity.INFO, `Successfully liquidated ${targetAddresses} via ${liquidator.address}`);
  //   } else {
  //     googleCloudLog(LogSeverity.ALERT, `Failed to liquidate ${targetAddresses} via ${liquidator.address}`);
  //   }
  // } catch (e) {
  //   throw e;
  //   // googleCloudLog(
  //   //   LogSeverity.ALERT,
  //   //   `Failed to liquidate ${targetAddresses} via ${liquidator.address}: ${e.message}`
  //   // );
  // }
}

async function getUniqueAddresses(comet: CometInterface): Promise<Set<string>> {
  // XXX how far back does this go?
  const withdrawEvents = await comet.queryFilter(comet.filters.Withdraw());
  return new Set(withdrawEvents.map(event => event.args.src));
}

export async function hasPurchaseableCollateral(comet: CometInterface, assets: Asset[], minUsdValue: number = 100): Promise<boolean> {
  let totalValue = 0n;
  const minValue = exp(minUsdValue, 8);
  for (const asset of assets) {
    const collateralReserves = await comet.getCollateralReserves(asset.address);
    const price = await comet.getPrice(asset.priceFeed);
    totalValue += collateralReserves.toBigInt() * price.toBigInt() / asset.scale;
    if (totalValue >= minValue) {
      return true;
    }
  }
  return false;
}

export async function liquidateUnderwaterBorrowers(
  comet: CometInterface,
  liquidator: Liquidator,
  signerWithFlashbots: SignerWithFlashbots,
  network: string
): Promise<boolean> {
  const uniqueAddresses = await getUniqueAddresses(comet);

  googleCloudLog(LogSeverity.INFO, `${uniqueAddresses.size} unique addresses found`);

  let liquidationAttempted = false;
  for (const address of uniqueAddresses) {
    const isLiquidatable = await comet.isLiquidatable(address);

    googleCloudLog(LogSeverity.INFO, `${address} isLiquidatable=${isLiquidatable}`);

    if (isLiquidatable) {
      await attemptLiquidation(
        comet,
        liquidator,
        [address],
        signerWithFlashbots,
        network
      );
      liquidationAttempted = true;
    }
  }
  return liquidationAttempted;
}

export async function arbitragePurchaseableCollateral(
  comet: CometInterface,
  liquidator: Liquidator,
  assets: Asset[],
  signerWithFlashbots: SignerWithFlashbots,
  network: string
) {
  googleCloudLog(LogSeverity.INFO, `Checking for purchaseable collateral`);

  if (await hasPurchaseableCollateral(comet, assets)) {
    googleCloudLog(LogSeverity.INFO, `There is purchaseable collateral`);
    await attemptLiquidation(
      liquidator,
      [], // empty list means we will only buy collateral and not absorb
      signerWithFlashbots,
      network
    );
  }
}

export async function getAssets(comet: CometInterface): Promise<Asset[]> {
  let numAssets = await comet.numAssets();
  let assets = [
    ...await Promise.all(Array(numAssets).fill(0).map(async (_, i) => {
      const asset = await comet.getAssetInfo(i);
      return { address: asset.asset, priceFeed: asset.priceFeed, scale: asset.scale.toBigInt() };
    })),
  ];
  return assets;
}
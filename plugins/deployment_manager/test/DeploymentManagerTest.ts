import { expect } from 'chai';
import hre from 'hardhat';
import nock from 'nock';

import {
  Dog,
  ProxyAdmin,
  TransparentUpgradeableProxy,
} from '../../../build/types';

import { getAliases } from '../Aliases';
import { getBuildFile } from '../ContractMap';
import { DeploymentManager } from '../DeploymentManager';
import { fiatTokenBuildFile, mockImportSuccess } from './ImportTest';
import { Migration } from '../Migration';
import { expectedTemplate } from './MigrationTemplateTest';
import { getProxies } from '../Proxies';
import { getRoots } from '../Roots';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';
import { VerifyArgs } from '../Verify';
import { getVerifyArgs, putVerifyArgs } from '../VerifyArgs';
import { mockVerifySuccess } from './VerifyTest';
import { objectFromMap } from '../Utils';

export interface TestContracts {
  finn: Dog;
  molly: Dog;
  spot: Dog;
  proxy: TransparentUpgradeableProxy;
  finnImpl: Dog;
  proxyAdmin: ProxyAdmin;
}

export async function setupContracts(deploymentManager: DeploymentManager): Promise<TestContracts> {
  let proxyAdminArgs: [] = [];
  let proxyAdmin: ProxyAdmin = await deploymentManager.deploy(
    'proxyAdmin',
    'vendor/proxy/transparent/ProxyAdmin.sol',
    proxyAdminArgs
  );

  let finnImpl: Dog = await deploymentManager.deploy(
    'finnImpl',
    'test/Dog.sol',
    ['finn:implementation', '0x0000000000000000000000000000000000000000', []]
  );

  let proxy: TransparentUpgradeableProxy = await deploymentManager.deploy(
    'proxy',
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [finnImpl.address, proxyAdmin.address, (
      await finnImpl.populateTransaction.initializeDog(
        'finn',
        finnImpl.address,
        []
      )
    ).data]);

  let molly: Dog = await deploymentManager.deploy(
    'molly',
    'test/Dog.sol',
    ['molly', proxy.address, []]
  );

  let spot: Dog = await deploymentManager.deploy(
    'spot',
    'test/Dog.sol',
    ['spot', proxy.address, []]
  );

  let finn = finnImpl.attach(proxy.address);

  await finn.addPup(molly.address);
  await finn.addPup(spot.address);

  deploymentManager.putRoots(new Map([['finn', finn.address]]));

  return {
    finn,
    molly,
    spot,
    proxy,
    finnImpl,
    proxyAdmin,
  };
}

describe('DeploymentManager', () => {
  beforeEach(async () => {
    nock.disableNetConnect();
  });

  describe('import', () => {
    it('should import succesfully', async () => {
      mockImportSuccess('0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e');
      let deploymentManager = new DeploymentManager('avalanche', 'frax', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let importResult = await deploymentManager.import(
        '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      );
      expect(importResult).to.eql(fiatTokenBuildFile);
    });
  });

  describe('deploy', () => {
    it('should deploy succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let spot: Dog = await deploymentManager.deploy(
        'spot',
        'test/Dog.sol',
        ['spot', '0x0000000000000000000000000000000000000000', []]
      );
      // Check that we've cached the build file
      expect((await getBuildFile(deploymentManager.cache, spot.address)).contract).to.eql('Dog');
    });
  });

  describe('_deployBuild', () => {
    it('should deployBuild succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let token = await deploymentManager._deployBuild(faucetTokenBuildFile, tokenArgs);
      expect(await token.symbol()).to.equal('TEST');
    });
  });

  describe('verifyContracts', () => {
    it('should verify contracts succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let verifyArgs: VerifyArgs = {
        via: 'artifacts',
        address: '0x0000000000000000000000000000000000000000',
        constructorArguments: []
      };
      await putVerifyArgs(
        deploymentManager.cache,
        '0x0000000000000000000000000000000000000000',
        verifyArgs
      );
      expect(objectFromMap(await getVerifyArgs(deploymentManager.cache))).to.eql({
        '0x0000000000000000000000000000000000000000': verifyArgs
      });

      mockVerifySuccess(hre);
      await deploymentManager.verifyContracts();

      // VerifyArgs cache should be cleared upon successful verification
      expect(objectFromMap(await getVerifyArgs(deploymentManager.cache))).to.eql({});
    });
  });

  describe('putAlias', () => {
    it('should putAlias succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      await deploymentManager.putAlias('finn', '0x0000000000000000000000000000000000000000');
      let aliases = await getAliases(deploymentManager.cache);
      expect(aliases.get('finn')).to.equal('0x0000000000000000000000000000000000000000');
    });

    it('should invalidate contract cache', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let spot: Dog = await deploymentManager.deploy(
        'spot',
        'test/Dog.sol',
        ['spot', '0x0000000000000000000000000000000000000000', []]
      );
      let molly: Dog = await deploymentManager.deploy(
        'molly',
        'test/Dog.sol',
        ['molly', '0x0000000000000000000000000000000000000000', []]
      );
      await deploymentManager.putAlias('pet', spot.address);
      expect(await (await deploymentManager.contract('pet')).name()).to.equal('spot');
      await deploymentManager.putAlias('pet', molly.address);
      expect(await (await deploymentManager.contract('pet')).name()).to.equal('molly');
    });
  });

  describe('putProxy', () => {
    it('should putProxy succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      await deploymentManager.putProxy('finn', '0x0000000000000000000000000000000000000000');
      let proxies = await getProxies(deploymentManager.cache);
      expect(proxies.get('finn')).to.equal('0x0000000000000000000000000000000000000000');
    });

    // TODO: Test cache invalidation?
  });

  describe('putRoots', () => {
    it('should putRoots succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      await deploymentManager.putRoots(
        new Map([['finn', '0x0000000000000000000000000000000000000000']])
      );
      let roots = await getRoots(deploymentManager.cache);
      expect(roots.get('finn')).to.equal('0x0000000000000000000000000000000000000000');
    });
  });

  describe('spider', () => {
    it('should spider succesfully', async () => {
      let deploymentManager = new DeploymentManager(
        'test-network',
        'test-deployment',
        hre, {
          importRetries: 0,
          writeCacheToDisk: true,
          baseDir: tempDir(),
        }
      );

      let { finnImpl: _finnImpl } = await setupContracts(
        deploymentManager
      );

      hre.config.deploymentManager.networks = {
        'test-network': {
          'test-deployment': {
            finn: {
              delegates: {
                field: {
                  slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
                },
              },
              relations: {
                father: {
                  alias: '.name',
                },
                pups: {
                  field: async (dog) => (await dog.callStatic.puppers()).map(({ pup }) => pup),
                  alias: ['.name'],
                },
              },
            },
          },
        },
      };

      await deploymentManager.spider();

      let check = {};
      for (let [alias, contract] of await deploymentManager.contracts()) {
        // Just make sure these contracts are working, too.
        let name = contract.hasOwnProperty('name') ? await contract.name() : null;
        check[alias] = name ? name : contract.address;
      }
      expect(check).to.eql({
        finn: 'finn',
        'finn:implementation': 'finn:implementation',
        molly: 'molly',
        spot: 'spot',
      });
    });
  });

  describe('contracts', () => {
    it('should get contracts succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });

      let { finn, finnImpl } = await setupContracts(
        deploymentManager
      );

      // TODO: Is this using the proxy correctly?
      await deploymentManager.putAlias('mydog', finn.address);
      await deploymentManager.putProxy('mydog', finnImpl.address);
      let contracts = await deploymentManager.contracts();

      expect(await contracts.get('mydog').name()).to.eql('finn');
    });
  });

  describe('contract', () => {
    it('should get contract succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });

      let { finn, finnImpl } = await setupContracts(
        deploymentManager
      );

      await deploymentManager.putAlias('mydog', finn.address);
      await deploymentManager.putProxy('mydog', finnImpl.address);
      let contract = await deploymentManager.contract('mydog');
      expect(await contract.name()).to.eql('finn');
    });
  });

  describe('generateMigration', () => {
    it('should generate expected migration', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });

      expect(await deploymentManager.generateMigration('cool', 1)).to.equal('1_cool.ts');

      expect(
        await deploymentManager.cache.readCache({ rel: ['migrations', '1_cool.ts'] })
      ).to.equal(expectedTemplate);
    });
  });

  describe('storeArtifact & readArtifact', () => {
    it('should store and retrieve a given artifact', async () => {
      let baseDir = tempDir();
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir,
      });

      let migration: Migration<null> = {
        name: '1_cool',
        actions: {
          prepare: async () => null,
          enact: async () => { /* */ },
        },
      };

      expect(await deploymentManager.readArtifact(migration)).to.eql(undefined);

      expect(await deploymentManager.storeArtifact(migration, { dog: 'cool' })).to.eql(
        `${baseDir}/test-network/test-deployment/artifacts/1_cool.json`
      );

      expect(await deploymentManager.readArtifact(migration)).to.eql({ dog: 'cool' });

      deploymentManager.cache.clearMemory();

      expect(await deploymentManager.readArtifact(migration)).to.eql({ dog: 'cool' });
    });
  });
});

import forge from 'node-forge';
import _ from 'lodash';
import fs from 'fs-extra';
import path from 'path';
import glob from 'glob-promise';
import plist from 'plist';

import { spawnAsyncThrowError } from './ExponentTools';

export async function ensureCertificateValid({ certPath, certPassword, teamID }) {
  const certData = await fs.readFile(certPath);
  const fingerprint = genCertFingerprint(certData, certPassword);
  const identities = await findIdentitiesByTeamID(teamID);
  const isValid = identities.indexOf(fingerprint) !== -1;
  if (!isValid) {
    throw new Error(`codesign ident not present in find-identity: ${fingerprint}\n${identities}`);
  }
  return fingerprint;
}

function genCertFingerprint(p12Buffer, passwordRaw) {
  if (Buffer.isBuffer(p12Buffer)) {
    p12Buffer = p12Buffer.toString('base64');
  } else if (typeof p12Buffer !== 'string') {
    throw new Error('genCertFingerprint only takes strings and buffers.');
  }

  const password = String(passwordRaw || '');
  const certBagType = forge.pki.oids.certBag;
  const p12Der = forge.util.decode64(p12Buffer);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  const certData = _.get(p12.getBags({ bagType: certBagType }), [certBagType, 0, 'cert']);
  if (!certData) {
    throw new Error("genCertFingerprint: couldn't find cert bag");
  }
  const certAsn1 = forge.pki.certificateToAsn1(certData);
  const certDer = forge.asn1.toDer(certAsn1).getBytes();
  return forge.md.sha1
    .create()
    .update(certDer)
    .digest()
    .toHex()
    .toUpperCase();
}

async function findIdentitiesByTeamID(teamID) {
  const { output } = await spawnAsyncThrowError(
    'security',
    ['find-identity', '-v', '-s', `(${teamID})`],
    {
      stdio: 'pipe',
    }
  );
  return output.join('');
}

export async function writeExportOptionsPlistFile(plistPath, data) {
  const toWrite = createExportOptionsPlist(data);
  await fs.writeFile(plistPath, toWrite);
}

const createExportOptionsPlist = ({
  bundleIdentifier,
  provisioningProfileUUID,
  exportMethod,
  teamID,
}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>method</key>
    <string>${exportMethod}</string>
    <key>teamID</key>
    <string>${teamID}</string>
    <key>provisioningProfiles</key>
    <dict>
      <key>${bundleIdentifier}</key>
      <string>${provisioningProfileUUID}</string>
    </dict>
  </dict>
</plist>`;

export async function buildIPA(
  {
    ipaPath,
    workspace,
    archivePath,
    codeSignIdentity,
    exportOptionsPlistPath,
    plistData,
    keychainPath,
    exportMethod,
  },
  credentials,
  client = false
) {
  if (client) {
    await spawnAsyncThrowError(
      'xcodebuild',
      [
        '-exportArchive',
        '-archivePath',
        archivePath,
        '-exportOptionsPlist',
        exportOptionsPlistPath,
        '-exportPath',
        path.Dir(ipaPath),
        `OTHER_CODE_SIGN_FLAGS="--keychain ${keychainPath}"`,
      ],
      {
        env: { ...process.env, CI: 1 },
      }
    );
  } else {
    await runFastlane(credentials, [
      'gym',
      '-n',
      path.basename(ipaPath),
      '--workspace',
      workspace,
      '--scheme',
      'ExpoKitApp',
      '--archive_path',
      archivePath,
      '--skip_build_archive',
      'true',
      '-i',
      codeSignIdentity,
      '--export_options',
      exportOptionsPlistPath,
      '--export_method',
      exportMethod,
      '--export_xcargs',
      `OTHER_CODE_SIGN_FLAGS="--keychain ${keychainPath}"`,
      '-o',
      path.dirname(ipaPath),
      '--verbose',
    ]);
  }
}

export const resolveExportMethod = plistData => {
  if (plistData.ProvisionedDevices) {
    return 'ad-hoc';
  } else if (plistData.ProvisionsAllDevices === true) {
    return 'enterprise';
  } else {
    return 'app-store';
  }
};

const entitlementTransferRules = [
  'com.apple.developer.associated-domains',
  'com.apple.developer.healthkit',
  'com.apple.developer.homekit',
  'com.apple.developer.icloud-container-identifiers',
  'com.apple.developer.icloud-services',
  'com.apple.developer.in-app-payments',
  'com.apple.developer.networking.vpn.api',
  'com.apple.developer.ubiquity-container-identifiers',
  'com.apple.developer.ubiquity-kvstore-identifier',
  'com.apple.external-accessory.wireless-configuration',
  'com.apple.security.application-groups',
  'inter-app-audio',
  'keychain-access-groups',
];

const blacklistedEntitlementKeys = [
  'com.apple.developer.icloud-container-development-container-identifiers',
  'com.apple.developer.icloud-container-environment',
  'com.apple.developer.icloud-container-identifiers',
  'com.apple.developer.icloud-services',
  'com.apple.developer.restricted-resource-mode',
  'com.apple.developer.ubiquity-container-identifiers',
  'com.apple.developer.ubiquity-kvstore-identifier',
  'inter-app-audio',
  'com.apple.developer.homekit',
  'com.apple.developer.healthkit',
  'com.apple.developer.in-app-payments',
  'com.apple.developer.maps',
  'com.apple.external-accessory.wireless-configuration',
];

export async function createEntitlementsFile({
  generatedEntitlementsPath,
  plistData,
  archivePath,
}) {
  const decodedProvisioningProfileEntitlements = plistData.Entitlements;

  const entitlementsPattern = path.join(
    archivePath,
    'Products/Applications/ExpoKitApp.app/*.entitlements'
  );
  const entitlementsPaths = await glob(entitlementsPattern);
  if (entitlementsPaths.length === 0) {
    throw new Error("Didn't find any generated entitlements file in archive.");
  } else if (entitlementsPaths.length !== 1) {
    throw new Error('Found more than one entitlements file.');
  }
  const archiveEntitlementsPath = entitlementsPaths[0];
  const archiveEntitlementsRaw = await fs.readFile(archiveEntitlementsPath);
  const archiveEntitlementsData = _.attempt(plist.parse, String(archiveEntitlementsRaw));
  if (_.isError(archiveEntitlementsData)) {
    throw new Error(`Error when parsing plist: ${archiveEntitlementsData.message}`);
  }

  const entitlements = { ...decodedProvisioningProfileEntitlements };
  entitlementTransferRules.forEach(rule => {
    if (rule in archiveEntitlementsData) {
      entitlements[rule] = archiveEntitlementsData[rule];
    }
  });
  const generatedEntitlements = _.pickBy(
    entitlements,
    (val, key) => !_.includes(blacklistedEntitlementKeys, key)
  );
  const generatedEntitlementsPlistData = _.attempt(plist.build, generatedEntitlements);
  await fs.writeFile(generatedEntitlementsPath, generatedEntitlementsPlistData, {
    mode: 0o755,
  });
  const { output } = await spawnAsyncThrowError(
    '/usr/libexec/PlistBuddy',
    ['-x', '-c', 'Print', generatedEntitlementsPath],
    {
      stdio: 'pipe',
    }
  );
  const plistDataReformatted = output.join('');
  await fs.writeFile(generatedEntitlementsPath, plistDataReformatted, {
    mode: 0o755,
  });
}

export async function resignIPA(
  {
    codeSignIdentity,
    entitlementsPath,
    provisioningProfilePath,
    sourceIpaPath,
    destIpaPath,
    keychainPath,
  },
  credentials
) {
  await spawnAsyncThrowError('cp', ['-rf', sourceIpaPath, destIpaPath]);
  await runFastlane(credentials, [
    'sigh',
    'resign',
    '--verbose',
    '--entitlements',
    entitlementsPath,
    '--signing_identity',
    codeSignIdentity,
    '--keychain_path',
    keychainPath,
    '--provisioning_profile',
    provisioningProfilePath,
    destIpaPath,
  ]);
}

async function runFastlane({ teamID, password }, fastlaneArgs) {
  const fastlaneEnvVars = {
    FASTLANE_SKIP_UPDATE_CHECK: 1,
    FASTLANE_DISABLE_COLORS: 1,
    FASTLANE_TEAM_ID: teamID,
    FASTLANE_PASSWORD: password,
    CI: 1,
    LC_ALL: 'en_US.UTF-8',
  };

  await spawnAsyncThrowError('fastlane', fastlaneArgs, {
    env: { ...process.env, ...fastlaneEnvVars },
    pipeToLogger: true,
    dontShowStdout: true,
  });
}

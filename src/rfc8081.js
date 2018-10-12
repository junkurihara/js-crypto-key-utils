/**
 * rfc8081
 */

import params, {getAlgorithmFromOidStrict} from './params.js';
import {PBES2ESParams, PBEParameter, PBES2Params, PBKDF2Params, OneAsymmetricKey} from './asn1def.js';
import des from 'des.js';
import BufferMod from 'buffer';
import asn from 'asn1.js';
import jseu from 'js-encoding-utils';
import jschash from 'js-crypto-hash/dist/index.js';
import jschmac from 'js-crypto-hmac/dist/index.js';
import jscrandom from 'js-crypto-random/dist/index.js';
import {EncryptedPrivateKeyInfo} from './asn1def';
const Buffer = BufferMod.Buffer;
const BN = asn.bignum;

export async function encryptEncryptedPrivateKeyInfo(binKey, passphrase, options = {}){
  // default params
  if(typeof options.algorithm === 'undefined') options.algorithm = 'pbes2';
  if(typeof options.iterationCount === 'undefined') options.iterationCount = 2048;


  if (options.algorithm === 'pbes2') {
    if(typeof options.cipher === 'undefined') options.cipher = 'des-ede3-cbc';
    if(typeof options.prf === 'undefined') options.prf = 'hmacWithSHA256';
    const kdfAlgorithm = 'pbkdf2'; // TODO: currently only pbkdf2 is available

    const encryptedPBES2 = await encryptPBES2(binKey, passphrase, kdfAlgorithm, options.prf, options.iterationCount, options.cipher);
    return await encodePBES2(encryptedPBES2);
  }
  else {
    const encryptedPBES1 = await encryptPBES1(binKey, passphrase, options.algorithm, options.iterationCount);
    encryptedPBES1.encryptionAlgorithm.algorithm = params.passwordBasedEncryptionSchemes[encryptedPBES1.encryptionAlgorithm.algorithm].oid;
    encryptedPBES1.encryptionAlgorithm.parameters = PBEParameter.encode(encryptedPBES1.encryptionAlgorithm.parameters, 'der');
    return EncryptedPrivateKeyInfo.encode(encryptedPBES1, 'der');
  }

  /**
   * TODO: binKeyの暗号化にまず必要なのは、encryptionAlgorithm = 'pbes2'とか。
   * TODO: encryptionAlgorithm = 'pbes2'のときは、
   * TODO: keyDerivationFunc(pbkdf2一択), そのパラメータとして prf = 'hmacWithSHA1', iterationCount=2048。Saltは8バイト？(not default)
   * TODO: encryptionScheme, そのパラメータとして'des-ede3-cbc'、ivがparameterに入ったりする。ivの長さはalgorithm次第。
   * TODO: pbes1のときは、algorithm(pbeWith略)と、salt(8bytes固定)のみ。
   */
  // const util = require('util');
  // console.log(util.inspect(encryptedPBES1,false,null));
}

///////////////////////////////////////////////////////////////////
export async function decryptEncryptedPrivateKeyInfo(decoded, passphrase){
  // encryptionAlgorithm.algorithm
  const encryptionAlgorithm = getAlgorithmFromOidStrict(decoded.encryptionAlgorithm.algorithm, params.passwordBasedEncryptionSchemes);
  decoded.encryptionAlgorithm.algorithm = encryptionAlgorithm;
  if (encryptionAlgorithm === 'pbes2') {
    decoded = decodePBES2(decoded);
  }
  else {
    decoded.encryptionAlgorithm.parameters = PBEParameter.decode(decoded.encryptionAlgorithm.parameters, 'der');
  }

  // decrypt
  if(decoded.encryptionAlgorithm.algorithm === 'pbes2') {
    return await decryptPBES2(decoded, passphrase);
  }
  else return await decryptPBES1(decoded, passphrase);
}

//////////////////////////////
function encodePBES2(decoded){
  // algorithm
  const algorithmOid = params.passwordBasedEncryptionSchemes[decoded.encryptionAlgorithm.algorithm].oid;
  decoded.encryptionAlgorithm.algorithm = algorithmOid;

  // kdf
  const kdf = decoded.encryptionAlgorithm.parameters.keyDerivationFunc;
  if(kdf.algorithm === 'pbkdf2') {
    kdf.algorithm = params.keyDerivationFunctions[kdf.algorithm].oid;
    kdf.parameters.prf.algorithm = params.pbkdf2Prfs[kdf.parameters.prf.algorithm].oid;
    kdf.parameters = PBKDF2Params.encode(kdf.parameters, 'der');
  } else throw new Error('UnsupportedKDF');

  decoded.encryptionAlgorithm.parameters.keyDerivationFunc = kdf;

  // encryptionScheme
  const eS = decoded.encryptionAlgorithm.parameters.encryptionScheme;
  if(Object.keys(PBES2ESParams).indexOf(eS.algorithm) >= 0){
    eS.parameters = PBES2ESParams[eS.algorithm].encode(eS.parameters, 'der');
  } else throw new Error('UnsupportedCipher');
  eS.algorithm = params.encryptionSchemes[eS.algorithm].oid;

  decoded.encryptionAlgorithm.parameters.encryptionScheme = eS;

  decoded.encryptionAlgorithm.parameters = PBES2Params.encode(decoded.encryptionAlgorithm.parameters, 'der');

  return EncryptedPrivateKeyInfo.encode(decoded, 'der');
}

function decodePBES2(decoded){
  const pbes2Params = PBES2Params.decode(decoded.encryptionAlgorithm.parameters, 'der');

  // keyDerivationFunc
  const kdfAlgorithm = getAlgorithmFromOidStrict(pbes2Params.keyDerivationFunc.algorithm, params.keyDerivationFunctions);
  pbes2Params.keyDerivationFunc.algorithm = kdfAlgorithm;

  if (kdfAlgorithm === 'pbkdf2') {
    const pbkdf2Params = PBKDF2Params.decode(pbes2Params.keyDerivationFunc.parameters, 'der');
    const pbkdf2Prf = getAlgorithmFromOidStrict(pbkdf2Params.prf.algorithm, params.pbkdf2Prfs);
    pbkdf2Params.prf.algorithm = pbkdf2Prf;

    pbes2Params.keyDerivationFunc.parameters = pbkdf2Params;
  } else throw new Error('UnsupportedKDF');

  //encryptionScheme
  const encryptionScheme = getAlgorithmFromOidStrict(pbes2Params.encryptionScheme.algorithm, params.encryptionSchemes);
  pbes2Params.encryptionScheme.algorithm = encryptionScheme;

  if(Object.keys(PBES2ESParams).indexOf(encryptionScheme) >= 0){
    pbes2Params.encryptionScheme.parameters =
      PBES2ESParams[encryptionScheme].decode(pbes2Params.encryptionScheme.parameters, 'der');
  } else throw new Error('UnsupportedCipher'); // TODO: Other Encryption Scheme

  decoded.encryptionAlgorithm.parameters = pbes2Params;

  return decoded;
}


//////////////////////
// PBES2 RFC8081 Section 6.2.1
async function encryptPBES2(binKey, passphrase, kdfAlgorithm, prf, iterationCount, cipher){
  // kdf
  const pBuffer = jseu.encoder.stringToArrayBuffer(passphrase);
  const salt = await jscrandom.getRandomBytes(
    params.keyDerivationFunctions[kdfAlgorithm].defaultSaltLen
  ); // TODO: currently only salt length of 8 is available
  const keyLength = params.encryptionSchemes[cipher].keyLength; // get keyLength

  let key;
  if (kdfAlgorithm === 'pbkdf2') {
    key = await pbkdf2(pBuffer, salt, iterationCount, keyLength, params.pbkdf2Prfs[prf].hash);
  } else throw new Error('UnsupportedKDF');

  // encrypt
  let iv;
  let encryptedData;
  if (cipher === 'des-ede3-cbc') { // TODO other encryption schemes
    iv = Buffer.from(await jscrandom.getRandomBytes(params.encryptionSchemes[cipher].ivLength));
    const CBC = des.CBC.instantiate(des.EDE);
    const ct = CBC.create({ type: 'encrypt', key: Buffer.from(key), iv });
    encryptedData = Buffer.from(ct.update(binKey).concat(ct.final()));
  } else throw new Error('UnsupportedCipher');

  // structure
  return {
    encryptedData,
    encryptionAlgorithm: {
      algorithm: 'pbes2',
      parameters: {
        keyDerivationFunc: {
          algorithm: kdfAlgorithm,
          parameters: {
            salt: {type: 'specified', value: Buffer.from(salt)},
            iterationCount: new BN(iterationCount),
            prf: {algorithm: prf, parameters: Buffer.from([0x05, 0x00])}
          }
        },
        encryptionScheme: { algorithm: cipher, parameters: iv }
      }
    }
  };
}

//////////////////////////////
// PBES2 RFC8081 Section 6.2.2
async function decryptPBES2(decoded, passphrase){
  const kdf = decoded.encryptionAlgorithm.parameters.keyDerivationFunc;
  const eS = decoded.encryptionAlgorithm.parameters.encryptionScheme;

  // pbkdf2
  const keyLength = params.encryptionSchemes[eS.algorithm].keyLength; // get keyLength
  let key;
  if(kdf.algorithm === 'pbkdf2') {
    const pBuffer = jseu.encoder.stringToArrayBuffer(passphrase);
    if (kdf.parameters.salt.type !== 'specified') throw new Error('UnsupportedSaltSource');
    const salt = new Uint8Array(kdf.parameters.salt.value);
    const iterationCount = kdf.parameters.iterationCount.toNumber();
    const prf = kdf.parameters.prf.algorithm;
    key = await pbkdf2(pBuffer, salt, iterationCount, keyLength, params.pbkdf2Prfs[prf].hash);
  }
  else throw new Error('UnsupportedKDF');

  // decryption
  // TODO other encryption schemes
  let out;
  if(eS.algorithm === 'des-ede3-cbc'){
    const iv = eS.parameters;
    const CBC = des.CBC.instantiate(des.EDE);
    const pt = CBC.create({ type: 'decrypt', key, iv });
    out = Buffer.from(pt.update(decoded.encryptedData).concat(pt.final()));
  }
  else throw new Error('UnsupportedEncryptionAlgorithm');

  return OneAsymmetricKey.decode(out, 'der');
}

async function pbkdf2(p, s, c, dkLen, hash) {
  // const crypto = require('crypto');
  // const key = crypto.pbkdf2Sync(p, s, c, dkLen, 'sha1');
  // console.log(key.toString('hex'));

  const hLen = params.hashes[hash].hashSize;

  const l = Math.ceil(dkLen/hLen);
  const r = dkLen - (l-1)*hLen;

  const funcF = async (i) => {
    const seed = new Uint8Array(s.length + 4);
    seed.set(s);
    seed.set(nwbo(i+1, 4), s.length);
    let u = await jschmac.compute(p, seed, hash);
    let outputF = new Uint8Array(u);
    for(let j = 1; j < c; j++){
      u = await jschmac.compute(p, u, hash);
      outputF = u.map( (elem, idx) => elem ^ outputF[idx]);
    }
    return {index: i, value: outputF};
  };
  const Tis = [];
  const DK = new Uint8Array(dkLen);
  for(let i = 0; i < l; i++) Tis.push(funcF(i));
  const TisResolved = await Promise.all(Tis);
  TisResolved.forEach( (elem) => {
    if (elem.index !== l - 1) DK.set(elem.value, elem.index*hLen);
    else DK.set(elem.value.slice(0, r), elem.index*hLen);
  });

  return DK;
}

function nwbo(num, len){
  const arr = new Uint8Array(len);

  for(let i=0; i<len; i++){
    arr[i] = 0xFF && (num >> ((len - i - 1)*8));
  }

  return arr;
}

//////////////////////////////
// PBES1 RFC8081 Section 6.1.1
async function encryptPBES1(binKey, passphrase, algorithm, iterationCount){
  // pbkdf1
  const pBuffer = jseu.encoder.stringToArrayBuffer(passphrase);
  const salt = await jscrandom.getRandomBytes(8); // defined as 8 octet
  const hash = params.passwordBasedEncryptionSchemes[algorithm].hash;
  const keyIv = await pbkdf1(pBuffer, salt, iterationCount, 16, hash);
  const key = keyIv.slice(0, 8);
  const iv = keyIv.slice(8, 16);

  // decryption
  const encrypt = params.passwordBasedEncryptionSchemes[algorithm].encrypt;
  let out;
  // TODO: Other Encryption Scheme
  if(encrypt === 'DES-CBC') {
    const CBC = des.CBC.instantiate(des.DES);
    const ct = CBC.create({type: 'encrypt', key, iv});
    out = Buffer.from(ct.update(binKey).concat(ct.final()));
  }
  else throw new Error('UnsupportedEncryptionAlgorithm');

  return {
    encryptionAlgorithm: {
      algorithm,
      parameters: {
        salt: Buffer.from(salt),
        iterationCount: new BN(iterationCount)
      }
    },
    encryptedData: out
  };
}

//////////////////////////////
// PBES1 RFC8081 Section 6.1.2
async function decryptPBES1(decoded, passphrase){
  // pbkdf1
  const pBuffer = jseu.encoder.stringToArrayBuffer(passphrase);
  const salt = new Uint8Array(decoded.encryptionAlgorithm.parameters.salt);
  const hash = params.passwordBasedEncryptionSchemes[decoded.encryptionAlgorithm.algorithm].hash;
  const iterationCount = decoded.encryptionAlgorithm.parameters.iterationCount.toNumber();
  const keyIv = await pbkdf1(pBuffer, salt, iterationCount, 16, hash);
  const key = keyIv.slice(0, 8);
  const iv = keyIv.slice(8, 16);

  // decryption
  const encrypt = params.passwordBasedEncryptionSchemes[decoded.encryptionAlgorithm.algorithm].encrypt;
  let out;
  // TODO: Other Encryption Scheme
  if(encrypt === 'DES-CBC') {
    const CBC = des.CBC.instantiate(des.DES);
    const ct = CBC.create({type: 'decrypt', key, iv});
    out = Buffer.from(ct.update(decoded.encryptedData).concat(ct.final()));
  }
  else throw new Error('UnsupportedEncryptionAlgorithm');

  return OneAsymmetricKey.decode(out, 'der');
}

async function pbkdf1(p, s, c, dkLen, hash){
  if(dkLen > params.hashes[hash].hashSize) throw new Error('TooLongIntendedKeyLength');
  let seed = new Uint8Array(p.length + s.length);
  seed.set(p);
  seed.set(s, p.length);
  for(let i = 0; i < c; i++){
    seed = await jschash.compute(seed, hash);
  }
  return seed.slice(0, dkLen);
}

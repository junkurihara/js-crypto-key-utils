/**
 * key.js
 */
import {fromJwkTo, toJwkFrom} from './converter.js';
import {getJwkThumbprint} from './thumbprint.js';

import jseu from 'js-encoding-utils';
import {getJwkType, getSec1KeyType, isAsn1Encrypted, isAsn1Public} from './util.js';


// key class
export class Key {
  constructor(format, key, options={}){
    this._jwk = {};
    this._der = null;
    this._oct = {}; // only for EC keys
    this._current = {jwk: false, der: false, oct: false};

    if(format === 'jwk'){
      this._setJwk(key);
    }
    else if (format === 'der' || format === 'pem'){
      this._setAsn1(key, format);
    }
    else if (format === 'oct'){
      if(typeof options.namedCurve === 'undefined') throw new Error('namedCurveMustBeSpecified');
      this._setSec1(key, options.namedCurve);
    }
    else throw new Error('UnsupportedType');
  }

  _setJwk(jwkey){
    this._type = getJwkType(jwkey); // this also check key format
    this._jwk = jwkey;
    if(this._isEncrypted) this._der = null;
    this._isEncrypted = false;
    this._setCurrentStatus();
  }

  _setAsn1(asn1key, format){
    this._type = (isAsn1Public(asn1key, format)) ? 'public' : 'private'; // this also check key format
    this._isEncrypted = isAsn1Encrypted(asn1key, format);
    this._der = (format === 'pem') ? jseu.formatter.pemToBin(asn1key): asn1key;
    if(this._isEncrypted){
      this._jwk = {};
      this._oct = {};
    }
    this._setCurrentStatus();
  }

  _setSec1(sec1key, namedCurve){
    this._type = getSec1KeyType(sec1key, namedCurve);  // this also check key format
    this._oct = { namedCurve, key: sec1key };
    if(this._isEncrypted) this._der = null;
    this._isEncrypted = false;
    this._setCurrentStatus();
  }

  _setCurrentStatus() {
    this._current.jwk = (
      typeof this._jwk.kty === 'string'
      && (this._jwk.kty === 'RSA' || this._jwk.kty === 'EC')
    );
    this._current.der = (
      typeof this._der !== 'undefined'
      && this._der instanceof Uint8Array
      && this._der.length > 0
    );
    this._current.oct = (
      typeof this._oct.key !== 'undefined'
      && this._oct.key instanceof Uint8Array
      && this._oct.key.length > 0
      && typeof this._oct.namedCurve === 'string'
    );
  }

  /**
   * Wrapper of converter
   * @param format {string}: 'jwk', 'pem', 'der' or 'oct'
   * @param options {object}:
   * - options.type {'public'|'private}: (optional) [format = *]
   *     only for derivation of public key from private key.
   * - options.compact {boolean}: (optional) [format = 'der', 'pem' or 'oct', only for EC key]
   *     generate compressed EC public key.
   * - options.encryptParams {object}: (optional) [format = 'der' or 'pem'] options to generate encrypted der/pem.
   *     * encryptParams.passphrase {string}: (mandatory if encOption is specified).
   *          (re-)generate encrypted der/pem with the given passphrase
   *     * encryptParams.algorithm {string}: (optional) 'pbes2' (default), 'pbeWithMD5AndDES-CBC' or 'pbeWithSHA1AndDES'
   *     * encryptParams.prf {string}: (optional) [encOptions.algorithm = 'pbes2'],
   *         'hmacWithSHA256' (default), 'hmacWithSHA384', 'hmacWithSHA512' or 'hmacWithSHA1'
   *     * encryptParams.iterationCount {integer}: 2048 (default)
   *     * encryptParams.cipher {string}: 'aes256-cbc' (default), 'aes128-cbc' or 'des-ede3-cbc'
   * @param passphrase {string}: (optional) [isEncrypted = true]
   *     use passphrase to decrypt imported encrypted-pem/der key if isEncrypted = true
   * @return {Promise<*>}
   */
  async export(format = 'jwk', options={}, passphrase){
    // global assertion
    if(['pem', 'der', 'jwk', 'oct'].indexOf(format) < 0) throw new Error('UnsupportedFormat');

    // return 'as is' without passphrase when nothing is given as 'options'
    // only for the case to export der key from der key (considering encrypted key)
    if((format === 'der' || format === 'pem')
      && Object.keys(options).length === 0
      && this._isEncrypted === true
      && this._type === 'private'
      && this._current.der){
      return (format === 'pem') ? jseu.formatter.binToPem(this._der, 'encryptedPrivate') : this._der;
    }

    let jwkey;
    // first converted to jwk
    if(this._current.jwk){
      jwkey = this._jwk;
    } else {
      if(this._current.oct) {
        jwkey = await toJwkFrom('oct', this._oct.key, {namedCurve: this._oct.namedCurve}); // type is not specified here to import jwk
      }
      else if(this._current.der){
        if(this._isEncrypted && typeof passphrase !== 'string') throw new Error('StringPassphraseIsRequired');
        jwkey = await toJwkFrom('der', this._der, {passphrase}); // type is not specified here to import jwk
      }
      else throw new Error('InvalidStatus');

      if(!this._isEncrypted) this._setJwk(jwkey); // store jwk if the exiting private key is not encrypted
    }

    // then export as the key in intended format
    if (format === 'der' || format === 'pem') {
      if(typeof options.encryptParams === 'undefined') options.encryptParams = {};
      return await fromJwkTo(format, jwkey, {
        type: options.type,
        compact: options.compact,
        passphrase: options.encryptParams.passphrase,
        encOptions: options.encryptParams
      });
    }
    else if (format === 'oct') {
      return await fromJwkTo(format, jwkey, {
        type: options.type,
        format: options.output,
        compact: options.compact
      });
    }
    else return jwkey;
  }

  /**
   *
   * @param passphrase
   * @return {Promise<boolean>}
   */
  async encrypt (passphrase){
    if(this._isEncrypted) throw new Error('AlreadyEncrypted');
    // lazy encryption
    await this.export('jwk');
    const options = {encryptParams: {passphrase}};
    this._setAsn1(await this.export('der', options), 'der');

    return true;
  }

  /**
   *
   * @param passphrase
   * @return {Promise<boolean>}
   */
  async decrypt (passphrase){
    if(!this._isEncrypted) throw new Error('NotEncrypted');
    // lazy decryption
    let jwkey;
    if(this._current.der && typeof passphrase === 'string'){
      jwkey = await toJwkFrom('der', this._der, {passphrase}); // type is not specified here to import jwk
    }
    else throw new Error('FailedToDecrypt');
    this._setJwk(jwkey);

    return true;
  }


  get isEncrypted(){
    return this._isEncrypted;
  }

  get isPrivate(){
    return this._type === 'private';
  }

  // getters only when unencrypted
  get der(){
    return this.export('der');
  }

  get pem(){
    return this.export('pem');
  }

  get jwk(){
    return this.export('jwk');
  }
}
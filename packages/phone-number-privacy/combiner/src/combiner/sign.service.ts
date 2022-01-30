import {
  DomainRestrictedSignatureRequest,
  ErrorMessage,
  GetBlindedMessageSigRequest,
  KEY_VERSION_HEADER,
  WarningMessage,
} from '@celo/phone-number-privacy-common'
import AbortController from 'abort-controller'
import { Request, Response } from 'express'
import { HeaderInit } from 'node-fetch'
import { BLSCryptographyClient } from '../bls/bls-cryptography-client'
import { respondWithError } from '../common/error-utils'
import { OdisConfig, VERSION } from '../config'
import { CombinerService, SignerPnpResponse } from './combiner.service'
import { IInputService } from './input.interface'

export type SignerSigResponse = SignerPnpResponse | DomainRestrictedSignatureRequest

export type SignRequest = DomainRestrictedSignatureRequest | GetBlindedMessageSigRequest

export abstract class SignService extends CombinerService {
  protected blsCryptoClient: BLSCryptographyClient
  protected pubKey: string
  protected keyVersion: number
  protected polynomial: string

  public constructor(config: OdisConfig, protected inputService: IInputService) {
    super(config, inputService)
    this.pubKey = config.keys.pubKey
    this.keyVersion = config.keys.version
    this.polynomial = config.keys.polynomial
    this.blsCryptoClient = new BLSCryptographyClient(this.threshold, this.pubKey, this.polynomial)
  }

  protected async inputCheck(
    request: Request<{}, {}, SignRequest>,
    response: Response
  ): Promise<boolean> {
    const reqKeyVersion = request.headers[KEY_VERSION_HEADER]
    if (reqKeyVersion && Number(reqKeyVersion) !== this.keyVersion) {
      respondWithError(response, 400, WarningMessage.INVALID_KEY_HEADER, this.logger)
      return false
    }
    return super.inputCheck(request, response)
  }

  protected headers(request: Request<{}, {}, GetBlindedMessageSigRequest>): HeaderInit | undefined {
    return {
      ...super.headers(request),
      [KEY_VERSION_HEADER]: this.keyVersion.toString(),
    }
  }

  protected async handleSuccessResponse(
    request: Request<{}, {}, SignRequest>,
    data: string,
    status: number,
    url: string,
    controller: AbortController
  ): Promise<void> {
    const res = JSON.parse(data)

    const resKeyVersion: number = Number(res.header(KEY_VERSION_HEADER))
    this.logger.info({ resKeyVersion }, 'Signer responded with key version')
    if (resKeyVersion !== this.keyVersion) {
      throw new Error(`Incorrect key version received from signer ${url}`) // TODO(Alec): Better error
    }

    const signature = this.parseSignature(res, url)

    if (!signature) {
      throw new Error(`Signature is missing from signer ${url}`)
    }

    this.responses.push({ url, res, status })

    this.logger.info({ signer: url }, 'Add signature')
    const signatureAdditionStart = Date.now()
    this.blsCryptoClient.addSignature({ url, signature })
    this.logger.info(
      {
        signer: url,
        hasSufficientSignatures: this.blsCryptoClient.hasSufficientSignatures(),
        additionLatency: Date.now() - signatureAdditionStart,
      },
      'Added signature'
    )
    // Send response immediately once we cross threshold
    // BLS threshold signatures can be combined without all partial signatures
    if (this.blsCryptoClient.hasSufficientSignatures()) {
      try {
        await this.blsCryptoClient.combinePartialBlindedSignatures(
          this.parseBlindedMessage(request.body)
        )
        // Close outstanding requests
        controller.abort()
      } catch {
        // Already logged, continue to collect signatures
      }
    }
  }

  protected async combineSignerResponses(
    request: Request<{}, {}, SignRequest>,
    response: Response
  ): Promise<void> {
    this.logResponseDiscrepancies()

    if (this.blsCryptoClient.hasSufficientSignatures()) {
      try {
        const combinedSignature = await this.blsCryptoClient.combinePartialBlindedSignatures(
          this.parseBlindedMessage(request.body),
          this.logger
        )
        response.json({ success: true, combinedSignature, version: VERSION })
        return
      } catch {
        // May fail upon combining signatures if too many sigs are invalid
        // Fallback to handleMissingSignatures
      }
    }

    this.handleMissingSignatures(this.getMajorityErrorCode(), response)
  }

  protected abstract logResponseDiscrepancies(): void

  protected abstract parseSignature(res: SignerSigResponse, signerUrl: string): string | undefined

  protected abstract parseBlindedMessage(req: SignRequest): string

  private handleMissingSignatures(majorityErrorCode: number | null, response: Response) {
    if (majorityErrorCode === 403) {
      respondWithError(response, 403, WarningMessage.EXCEEDED_QUOTA, this.logger)
    } else {
      respondWithError(
        response,
        majorityErrorCode || 500,
        ErrorMessage.NOT_ENOUGH_PARTIAL_SIGNATURES,
        this.logger
      )
    }
  }
}

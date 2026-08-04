import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { SignatureService } from './signature.service';

@Global()
@Module({
  providers: [CryptoService, SignatureService],
  exports: [CryptoService, SignatureService],
})
export class SecurityModule {}

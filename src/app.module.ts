import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionService } from './session.service';
import { CryptoService } from './crypto.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, SessionService, CryptoService],
})
export class AppModule {}

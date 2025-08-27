import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionService } from './session.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, SessionService],
})
export class AppModule {}

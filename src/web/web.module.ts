import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { EcourtsModule } from '../ecourts/ecourts.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { WebUiController } from './web-ui.controller';

/**
 * The signed-in web application: its API and the page that loads it.
 *
 * Web-process only. Unlike the WhatsApp side there is nothing here for the
 * worker to do - a browser request is answered on the connection it arrived on,
 * so there is no queue and no consumer. See the class comment in
 * chat.service.ts for why the two clients differ on that.
 */
@Module({
  imports: [AiModule, AuthModule, CreditsModule, EcourtsModule],
  controllers: [WebUiController, ChatController],
  providers: [ChatService],
})
export class WebModule {}

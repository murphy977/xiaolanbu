import { Global, Module } from "@nestjs/common";

import { PostgresStateService } from "./postgres-state.service";
import { StoreService } from "./store.service";

@Global()
@Module({
  providers: [StoreService, PostgresStateService],
  exports: [StoreService, PostgresStateService],
})
export class StoreModule {}

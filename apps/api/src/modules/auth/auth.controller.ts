import { Controller, Get } from "@nestjs/common";

import { StoreService } from "../store/store.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly storeService: StoreService) {}

  @Get("me")
  getMe() {
    return {
      user: this.storeService.getCurrentUser(),
      workspaces: this.storeService.listWorkspaces(),
    };
  }
}

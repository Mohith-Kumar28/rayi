export type AuthConfig = {
  authSecret: string;
  basicAuth: {
    username: string;
    password: string;
  };
  oAuth: {
    github: {
      clientId?: string;
      clientSecret?: string;
    };
  };
};

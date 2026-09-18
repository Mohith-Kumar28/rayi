export enum DatabaseSSLMode {
  require = 'require',
  disable = 'disable',
}

export type DatabaseConfig = {
  url: string;
};

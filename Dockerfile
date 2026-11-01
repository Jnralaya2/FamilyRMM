FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY dist ./dist

FROM node:24-bookworm-slim AS wixl-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget xz-utils python3 python3-venv build-essential bison valac ninja-build libglib2.0-dev libgcab-dev libgsf-1-dev libxml2-dev gettext gobject-introspection libgirepository1.0-dev \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/meson-venv \
    && /opt/meson-venv/bin/pip install --no-cache-dir meson==1.4.2
RUN wget -q https://download.gnome.org/sources/msitools/0.106/msitools-0.106.tar.xz -O /tmp/msitools.tar.xz \
    && echo '1ed34279cf8080f14f1b8f10e649474125492a089912e7ca70e59dfa2e5a659b  /tmp/msitools.tar.xz' | sha256sum -c - \
    && mkdir -p /tmp/msitools-src \
    && tar -xf /tmp/msitools.tar.xz -C /tmp/msitools-src \
    && /opt/meson-venv/bin/meson setup /tmp/msitools-build /tmp/msitools-src/msitools-0.106 --prefix=/usr/local \
    && ninja -C /tmp/msitools-build install

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget libglib2.0-0 libgcab-1.0-0 libgsf-1-114 libxml2 \
    && wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O /tmp/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-sdk-10.0 \
    && rm -f /tmp/packages-microsoft-prod.deb \
    && apt-get purge -y wget \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY --from=wixl-build /usr/local /usr/local
RUN ldconfig && wixl --version && msiinfo --version
ENV DOTNET_CLI_HOME=/home/node/.dotnet \
    NUGET_PACKAGES=/home/node/.nuget/packages \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node agent ./agent
USER node
RUN dotnet restore agent/FamilyRmm.Agent/FamilyRmm.Agent.csproj \
      --runtime win-x64 \
      --packages "$NUGET_PACKAGES" \
      --disable-parallel \
      -p:EnableWindowsTargeting=true \
      -p:RestoreRetryCount=5 \
      -p:RestoreRetryDelayMilliseconds=2000 \
    && dotnet restore agent/FamilyRmm.Bootstrapper/FamilyRmm.Bootstrapper.csproj \
      --runtime win-x64 \
      --packages "$NUGET_PACKAGES" \
      --disable-parallel \
      -p:EnableWindowsTargeting=true \
      -p:RestoreRetryCount=5 \
      -p:RestoreRetryDelayMilliseconds=2000
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY scripts ./scripts
USER root
RUN mkdir -p /var/lib/family-rmm && chown node:node /var/lib/family-rmm
EXPOSE 3000
USER node
CMD ["node", "src/server/index.mjs"]

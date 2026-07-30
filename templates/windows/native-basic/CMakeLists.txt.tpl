cmake_minimum_required(VERSION 3.20)

project(__PROJECT_NAME__ LANGUAGES CXX)

set(CMAKE_CXX_STANDARD __CPP_STANDARD__)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(__BUILD_TYPE__ STREQUAL "executable")
  add_executable(${PROJECT_NAME} src/main.cpp)
elseif(__BUILD_TYPE__ STREQUAL "library")
  add_library(${PROJECT_NAME} STATIC src/main.cpp)
endif()

if(__WITH_TESTS__)
  enable_testing()
  add_subdirectory(tests)
endif()
